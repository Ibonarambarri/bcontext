"use client";

/**
 * Configure modal for one connected integration (the gear on a hub row):
 * what Nexo should learn from it (free text), when it runs (cadence),
 * plus Run now and Disconnect. Save goes to PATCH /api/connectors/:id/config,
 * Run now to POST /sync, Disconnect (confirmed) to POST /uninstall.
 *
 * OAuth providers through Nango also show which OAuth app the install
 * authorises through (Bcontext's shared one or the workspace's own):
 * "Replace credentials" PUTs new own-app credentials to
 * /api/connectors/:id/oauth-app, "Switch to Bcontext's app" DELETEs them —
 * optimistic, reverted with the error shown if the API refuses.
 */
import { useState } from "react";
import { KeyRound, Play, Unplug } from "lucide-react";
import {
  AlertDialog,
  Button,
  Input,
  Label,
  ListBox,
  Modal,
  Select,
  Spinner,
  TextArea,
  TextField,
} from "@heroui/react";
import { CadenceSchema, type Cadence } from "@bcontext-dev/contract/connectors/cadence";
import { canUseOwnApp, installOAuthApp } from "@/lib/integrations/catalog";
import type { ConnectorInstall, IntegrationCatalogEntry, IntegrationOAuthApp, OwnOAuthAppInput } from "@/lib/integrations/types";
import { OAuthAppModal } from "./oauth-app-modal";

const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const CADENCE_OPTIONS: { id: Cadence["mode"]; label: string }[] = [
  { id: "hourly", label: "Hourly" },
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Weekly" },
  { id: "monthly", label: "Monthly" },
];

const fieldClass =
  "mt-1 flex h-8 w-full items-center justify-between rounded-md border border-[var(--line)] bg-[var(--paper-2)] px-2 text-[12px]";

export function ConfigureIntegrationModal({
  workspaceId,
  install,
  entry,
  title,
  onClose,
  onSaved,
  onRunNow,
  onReconnect,
  onDisconnected,
}: {
  workspaceId: string;
  install: ConnectorInstall;
  /** Catalog entry, when known — drives the OAuth app row. */
  entry?: IntegrationCatalogEntry | null;
  title: string;
  onClose: () => void;
  onSaved: (next: ConnectorInstall) => void;
  onRunNow: (install: ConnectorInstall) => Promise<void>;
  /** The API dropped the connection (OAuth app changed): connect again. */
  onReconnect?: (install: ConnectorInstall) => void | Promise<void>;
  onDisconnected: (install: ConnectorInstall) => void;
}) {
  const existing = CadenceSchema.safeParse(install.config.cadence);
  const [guidance, setGuidance] = useState(
    typeof install.config.ingest_guidance === "string" ? install.config.ingest_guidance : "",
  );
  const [mode, setMode] = useState<Cadence["mode"]>(existing.success ? existing.data.mode : "daily");
  const [hour, setHour] = useState(existing.success && "hour" in existing.data ? existing.data.hour : 9);
  const [dayOfWeek, setDayOfWeek] = useState(
    existing.success && existing.data.mode === "weekly" ? existing.data.day_of_week : 1,
  );
  const [dayOfMonth, setDayOfMonth] = useState(
    existing.success && existing.data.mode === "monthly" ? existing.data.day_of_month : 1,
  );
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hybrid OAuth (Nango-backed OAuth providers only).
  const oauthProvider = entry ? canUseOwnApp(entry) : false;
  const sharedAppReady = entry?.setup === "ready";
  const [oauthApp, setOauthApp] = useState<IntegrationOAuthApp>(installOAuthApp(install.config));
  const [replacing, setReplacing] = useState(false);
  const [switching, setSwitching] = useState(false);

  async function replaceCredentials(input: OwnOAuthAppInput) {
    const previous = oauthApp;
    setOauthApp("own");
    setError(null);
    try {
      const r = await fetch(`/api/connectors/${encodeURIComponent(install.connector_id)}/oauth-app`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId, ...input }),
      });
      const body = (await r.json().catch(() => ({}))) as {
        install?: ConnectorInstall;
        reconnect_required?: boolean;
        error?: string;
        message?: string;
      };
      if (!r.ok) throw new Error(body.message ?? (typeof body.error === "string" ? body.error : `HTTP ${r.status}`));
      setReplacing(false);
      const next = body.install ?? { ...install, config: { ...install.config, oauth_app: "own" } };
      if (body.reconnect_required && onReconnect) await onReconnect(next);
      else onSaved(next);
    } catch (e) {
      setOauthApp(previous);
      throw e;
    }
  }

  async function switchToShared() {
    const previous = oauthApp;
    setOauthApp("shared");
    setSwitching(true);
    setError(null);
    try {
      const r = await fetch(`/api/connectors/${encodeURIComponent(install.connector_id)}/oauth-app`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId }),
      });
      const body = (await r.json().catch(() => ({}))) as {
        install?: ConnectorInstall;
        reconnect_required?: boolean;
        error?: string;
        message?: string;
      };
      if (!r.ok) throw new Error(body.message ?? (typeof body.error === "string" ? body.error : `HTTP ${r.status}`));
      const next = body.install ?? { ...install, config: { ...install.config, oauth_app: "shared" } };
      if (body.reconnect_required && onReconnect) await onReconnect(next);
      else onSaved(next);
    } catch (e) {
      setOauthApp(previous);
      setError((e as Error).message);
    } finally {
      setSwitching(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const cadence: Cadence =
        mode === "hourly"
          ? { mode: "hourly" }
          : mode === "daily"
            ? { mode: "daily", hour }
            : mode === "weekly"
              ? { mode: "weekly", hour, day_of_week: dayOfWeek }
              : { mode: "monthly", hour, day_of_month: dayOfMonth };
      const r = await fetch(`/api/connectors/${encodeURIComponent(install.connector_id)}/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId, ingest_guidance: guidance, cadence }),
      });
      const body = (await r.json().catch(() => ({}))) as { install?: ConnectorInstall; error?: string; message?: string };
      if (!r.ok) throw new Error(body.message ?? (typeof body.error === "string" ? body.error : `HTTP ${r.status}`));
      onSaved(body.install ?? { ...install, config: { ...install.config, ingest_guidance: guidance, cadence } });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function runNow() {
    setRunning(true);
    try {
      await onRunNow(install);
    } finally {
      setRunning(false);
    }
  }

  async function disconnect() {
    setDisconnecting(true);
    setError(null);
    try {
      const r = await fetch(`/api/connectors/${encodeURIComponent(install.connector_id)}/uninstall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string; message?: string };
        throw new Error(body.message ?? (typeof body.error === "string" ? body.error : `HTTP ${r.status}`));
      }
      setConfirmDisconnect(false);
      onDisconnected(install);
    } catch (e) {
      setError((e as Error).message);
      setConfirmDisconnect(false);
    } finally {
      setDisconnecting(false);
    }
  }

  const busy = saving || running || disconnecting || switching;

  return (
    <>
      <Modal.Backdrop
        isOpen
        onOpenChange={(next) => {
          if (!next && !busy) onClose();
        }}
      >
        <Modal.Container placement="center" size="sm" scroll="inside">
          <Modal.Dialog aria-label={`Configure ${title}`} className="w-full max-w-[460px]">
            <Modal.CloseTrigger />
            <Modal.Header className="gap-0.5">
              <Modal.Heading className="text-[15px] font-medium">Configure {title}</Modal.Heading>
              <p className="m-0 text-[11.5px] leading-[1.5] text-[var(--ink-3)]">
                Nexo reads this integration on the cadence below and writes what it learns into the brain.
              </p>
            </Modal.Header>

            <Modal.Body className="flex flex-col gap-3">
              {error ? (
                <div role="alert" className="rounded-md border border-red-500/30 bg-red-500/5 p-2 text-[11.5px] text-red-600">
                  {error}
                </div>
              ) : null}

              <TextField value={guidance} onChange={setGuidance} className="block">
                <Label className="block text-[11px] text-[var(--ink-3)]">What should Nexo learn from it?</Label>
                <TextArea
                  placeholder="e.g. collect the decisions taken in #product and #eng, ignore stand-up chatter"
                  rows={3}
                  className="mt-1 w-full resize-none rounded-md border border-[var(--line)] bg-[var(--paper-2)] p-2 text-[12px] outline-none focus:border-[var(--line-strong)]"
                />
              </TextField>

              <Select className="block" value={mode} onChange={(value) => setMode(value as Cadence["mode"])}>
                <Label className="block text-[11px] text-[var(--ink-3)]">When does it run?</Label>
                <Select.Trigger className={fieldClass}>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {CADENCE_OPTIONS.map((option) => (
                      <ListBox.Item key={option.id} id={option.id} textValue={option.label}>
                        {option.label}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>

              {oauthProvider ? (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--paper-2)] px-2.5 py-2">
                  <KeyRound size={12} className="shrink-0 text-[var(--ink-3)]" />
                  <div className="min-w-0 flex-1">
                    <p className="m-0 text-[11px] text-[var(--ink-3)]">OAuth app</p>
                    <p className="m-0 text-[12px] font-medium text-[var(--ink)]">
                      {oauthApp === "own" ? "Your own app" : "Bcontext"}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    isDisabled={busy}
                    onPress={() => setReplacing(true)}
                    className="h-7 text-[11.5px] text-[var(--ink-2)]"
                  >
                    {oauthApp === "own" ? "Replace credentials" : "Use your own app"}
                  </Button>
                  {oauthApp === "own" && sharedAppReady ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      isDisabled={busy}
                      onPress={() => void switchToShared()}
                      className="h-7 text-[11.5px] text-[var(--ink-2)]"
                    >
                      {switching ? <Spinner size="sm" color="current" /> : null}
                      Switch to Bcontext&apos;s app
                    </Button>
                  ) : null}
                </div>
              ) : null}

              {mode !== "hourly" ? (
                <div className="flex gap-2">
                  {mode === "weekly" ? (
                    <Select className="block flex-1" value={dayOfWeek} onChange={(value) => setDayOfWeek(Number(value))}>
                      <Label className="block text-[11px] text-[var(--ink-3)]">Day</Label>
                      <Select.Trigger className={fieldClass}>
                        <Select.Value />
                        <Select.Indicator />
                      </Select.Trigger>
                      <Select.Popover>
                        <ListBox>
                          {DAY_LABELS.map((day, index) => (
                            <ListBox.Item key={day} id={index} textValue={day}>
                              {day}
                              <ListBox.ItemIndicator />
                            </ListBox.Item>
                          ))}
                        </ListBox>
                      </Select.Popover>
                    </Select>
                  ) : null}
                  {mode === "monthly" ? (
                    <TextField
                      type="number"
                      value={String(dayOfMonth)}
                      onChange={(value) => setDayOfMonth(Math.min(28, Math.max(1, Number(value) || 1)))}
                      className="block flex-1"
                    >
                      <Label className="block text-[11px] text-[var(--ink-3)]">Day of month</Label>
                      <Input min={1} max={28} className={fieldClass} />
                    </TextField>
                  ) : null}
                  <TextField
                    type="number"
                    value={String(hour)}
                    onChange={(value) => setHour(Math.min(23, Math.max(0, Number(value) || 0)))}
                    className="block flex-1"
                  >
                    <Label className="block text-[11px] text-[var(--ink-3)]">Hour (UTC)</Label>
                    <Input min={0} max={23} className={fieldClass} />
                  </TextField>
                </div>
              ) : null}
            </Modal.Body>

            <Modal.Footer className="flex flex-wrap items-center gap-2">
              <Button
                variant="danger-soft"
                size="sm"
                isDisabled={busy}
                onPress={() => setConfirmDisconnect(true)}
                className="gap-1.5"
              >
                <Unplug size={12} />
                Disconnect
              </Button>
              <Button variant="outline" size="sm" isDisabled={busy} onPress={() => void runNow()} className="gap-1.5">
                {running ? <Spinner size="sm" color="current" /> : <Play size={12} />}
                Run now
              </Button>
              <span className="flex-1" />
              <Button variant="ghost" size="sm" isDisabled={busy} onPress={onClose}>
                Cancel
              </Button>
              <Button size="sm" isDisabled={busy} onPress={() => void save()} className="gap-1.5">
                {saving ? <Spinner size="sm" color="current" /> : null}
                {saving ? "Saving…" : "Save"}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      {replacing && entry ? (
        <OAuthAppModal
          entry={entry}
          setup={entry.oauth_setup ?? null}
          mode="replace"
          onClose={() => setReplacing(false)}
          onSubmit={replaceCredentials}
        />
      ) : null}

      {confirmDisconnect ? (
        <AlertDialog.Backdrop
          isOpen
          onOpenChange={(next) => {
            if (!next && !disconnecting) setConfirmDisconnect(false);
          }}
        >
          <AlertDialog.Container placement="center">
            <AlertDialog.Dialog aria-labelledby="disconnect-integration-title" className="w-full max-w-[420px]">
              <AlertDialog.Header className="flex-col items-start gap-0">
                <AlertDialog.Icon status="danger">
                  <Unplug size={15} />
                </AlertDialog.Icon>
                <AlertDialog.Heading id="disconnect-integration-title" className="mt-4 text-[15px] font-medium">
                  Disconnect {title}?
                </AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <p className="mt-1 text-[11.5px] leading-relaxed text-muted">
                  Nexo stops reading it and its credentials are revoked. Everything already learned stays in the brain with its provenance.
                </p>
              </AlertDialog.Body>
              <AlertDialog.Footer className="flex">
                <Button isDisabled={disconnecting} onPress={() => setConfirmDisconnect(false)} variant="outline" size="sm">
                  Cancel
                </Button>
                <Button isDisabled={disconnecting} onPress={() => void disconnect()} variant="danger" size="sm" className="ml-auto gap-1.5">
                  {disconnecting ? <Spinner size="sm" color="current" /> : <Unplug size={11} />}
                  {disconnecting ? "Disconnecting…" : "Disconnect"}
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      ) : null}
    </>
  );
}
