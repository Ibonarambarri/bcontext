"use client";

/**
 * The workspace's connected apps, managed: one row per install with its
 * status, what Nexo learns from it, when it runs, and the gear → Configure
 * modal (cadence, run now, reconnect, disconnect). Rows glow (`.bx-aura`)
 * while their connector is fetching or Nexo is processing what came back —
 * `GET /api/integrations/activity`, polled every 10 s while mounted.
 * Mounted, collapsed, at the bottom of a Nexo's Setup → Sources
 * (`nexos/nexo-sources.tsx`), which owns connecting and assigning.
 *
 * Also exports `useConnectorInstall`, the one way to connect an app (native
 * redirect, Nango Connect UI, instant installs, and the hybrid-OAuth 409
 * that asks for the workspace's own app); Sources and this hub's
 * Reconnect both go through it.
 *
 * Installs come from `GET /api/connectors` (polled every 30 s), the catalog
 * from `GET /api/integrations/catalog`; connecting goes through
 * `POST /api/connectors/:key/install`.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Plug, Settings2 } from "lucide-react";
import { Button, Chip, Tooltip } from "@heroui/react";
import { EmptyState } from "@/components/ui/empty-state";
import { IngestQueueSkeleton } from "@/components/skeletons";
import { RecordMeetingModal } from "@/components/agents/record-meeting-modal";
import { useWorkspaceBroadcast } from "@/lib/collab/workspace-realtime";
import type { MeetingBotStatus } from "@bcontext-dev/contract/connectors/meeting-bot/provider";
import { useWorkspace } from "../workspace-context";
import { ConfigureIntegrationModal } from "./configure-modal";
import type { ConnectOptions } from "./marketplace-modal";
import { MeetingRecordsSetupModal, type MeetingRecordsConfig } from "./meeting-records-setup-modal";
import { OAuthAppModal } from "./oauth-app-modal";
import { ProviderLogo } from "./provider-logo";
import { openNangoConnect } from "@/lib/integrations/connect-nango";
import { NATIVE_CATALOG, needsOwnApp } from "@/lib/integrations/catalog";
import type {
  ConnectorInstall,
  ConnectorInstallAccess,
  InstallResponse,
  IntegrationActivity,
  IntegrationCatalogEntry,
  IntegrationOAuthSetup,
  OwnOAuthAppInput,
} from "@/lib/integrations/types";
import { cadenceLabel, CadenceSchema } from "@bcontext-dev/contract/connectors/cadence";
import { cn, formatRelative } from "@bcontext-dev/contract/utils";
import { workspaceApiRef, type WorkspaceAddress } from "@/web/workspace-url";

const ACTIVITY_POLL_MS = 10_000;
const INSTALLS_POLL_MS = 30_000;

interface MeetingBotStatusEvent {
  botId: string;
  status: MeetingBotStatus;
}

function isLiveMeetingStatus(status: MeetingBotStatus): boolean {
  return status === "joining" || status === "in_call" || status === "call_ended" || status === "transcribing";
}

/**
 * Connecting an app, every path: native OAuth (a full-page redirect — call
 * `beforeRedirect` to remember where to come back), Nango's Connect UI,
 * installs that need no hop, and the hybrid-OAuth 409 that asks for the
 * workspace's own app (`ownAppModal` renders that form; mount it).
 * `onInstalled` gets the fresh install whenever the connection completes on
 * this page.
 */
export function useConnectorInstall({
  onInstalled,
  beforeRedirect,
}: {
  onInstalled?: (install: ConnectorInstall, entry: IntegrationCatalogEntry) => void | Promise<void>;
  beforeRedirect?: (entry: IntegrationCatalogEntry) => void;
}) {
  const { workspace: current, toast } = useWorkspace();
  const workspaceId = current?.id ?? null;
  const [connecting, setConnecting] = useState<string | null>(null);
  // The entry whose own-app form is open, plus what the form must show (the
  // catalog's `oauth_setup`, or the one a 409 answered with).
  const [ownAppFor, setOwnAppFor] = useState<{ entry: IntegrationCatalogEntry; setup: IntegrationOAuthSetup | null } | null>(null);

  /** `oauthApp` is only set when the person submitted the own-app form; it is sent once and never kept. */
  const install = useCallback(
    async (entry: IntegrationCatalogEntry, oauthApp?: OwnOAuthAppInput): Promise<"done" | "needs_oauth_app"> => {
      if (!workspaceId) throw new Error("Connect a persisted workspace first.");
      const r = await fetch(`/api/connectors/${encodeURIComponent(entry.key)}/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId, ...(oauthApp ? { oauth_app: oauthApp } : {}) }),
      });
      const body = (await r.json().catch(() => ({}))) as InstallResponse;
      if (r.status === 409 && body.error === "needs_oauth_app") {
        setOwnAppFor({ entry, setup: body.oauth_setup ?? entry.oauth_setup ?? null });
        return "needs_oauth_app";
      }
      if (!r.ok) throw new Error(body.message ?? (typeof body.error === "string" ? body.error : `HTTP ${r.status}`));

      if (body.connect?.session_token) {
        setOwnAppFor(null);
        await openNangoConnect(body.connect.session_token);
        toast.info(`${entry.name} connected.`);
        if (body.install) await onInstalled?.({ ...body.install, status: "active" }, entry);
        return "done";
      }
      const redirect = body.redirect_url ?? body.redirectUrl;
      if (redirect) {
        beforeRedirect?.(entry);
        window.location.href = redirect;
        return "done";
      }
      // Installed without a hop (API key / app already authorised).
      setOwnAppFor(null);
      toast.info(`${entry.name} connected.`);
      if (body.install) await onInstalled?.(body.install, entry);
      return "done";
    },
    [workspaceId, toast, onInstalled, beforeRedirect],
  );

  const connect = useCallback(
    async (entry: IntegrationCatalogEntry, options?: ConnectOptions) => {
      if (!workspaceId) {
        toast.error("Connect a persisted workspace first.");
        return;
      }
      if (options?.ownApp || needsOwnApp(entry)) {
        // Straight to the form: no shared app, or the workspace prefers its own.
        setOwnAppFor({ entry, setup: entry.oauth_setup ?? null });
        return;
      }
      setConnecting(entry.key);
      try {
        await install(entry);
      } catch (e) {
        const message = (e as Error).message;
        if (message !== "closed") toast.error(`Could not connect ${entry.name}: ${message}`);
      } finally {
        setConnecting(null);
      }
    },
    [workspaceId, toast, install],
  );

  const ownAppModal = ownAppFor ? (
    <OAuthAppModal
      entry={ownAppFor.entry}
      setup={ownAppFor.setup}
      mode="connect"
      onClose={() => setOwnAppFor(null)}
      onSubmit={async (input) => {
        setConnecting(ownAppFor.entry.key);
        try {
          const outcome = await install(ownAppFor.entry, input);
          if (outcome === "needs_oauth_app") throw new Error("The credentials were not accepted. Check the client ID and secret.");
        } finally {
          setConnecting(null);
        }
      }}
    />
  ) : null;

  return { connect, install, connecting, ownAppModal, workspaceId };
}

export function IntegrationsHub({ workspace }: { workspace: WorkspaceAddress }) {
  const { toast } = useWorkspace();

  const [installs, setInstalls] = useState<ConnectorInstall[]>([]);
  const [catalog, setCatalog] = useState<Map<string, IntegrationCatalogEntry>>(
    () => new Map(NATIVE_CATALOG.map((entry) => [entry.key, entry])),
  );
  const [activity, setActivity] = useState<Map<string, IntegrationActivity>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configuring, setConfiguring] = useState<ConnectorInstall | null>(null);

  // Meeting records keeps its own flagship flow (setup wizard + Record).
  const [meetingConfig, setMeetingConfig] = useState<MeetingRecordsConfig | null>(null);
  const [meetingSetupOpen, setMeetingSetupOpen] = useState(false);
  const [recordOpen, setRecordOpen] = useState(false);
  const [meetingLive, setMeetingLive] = useState<MeetingBotStatus | null>(null);

  const loadInstalls = useCallback(async () => {
    try {
      const r = await fetch(`/api/connectors?workspace=${encodeURIComponent(workspaceApiRef(workspace))}`, { cache: "no-store" });
      const body = (await r.json().catch(() => ({}))) as { installs?: ConnectorInstall[]; error?: string };
      if (!r.ok) throw new Error(typeof body.error === "string" ? body.error : `HTTP ${r.status}`);
      setInstalls((body.installs ?? []).filter((i) => i.status !== "uninstalled"));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, [workspace]);

  const { install, ownAppModal, workspaceId } = useConnectorInstall({ onInstalled: loadInstalls });

  const loadMeetingConfig = useCallback(async () => {
    try {
      const r = await fetch(
        `/api/integrations/meeting-records/config?workspace=${encodeURIComponent(workspaceApiRef(workspace))}`,
        { cache: "no-store" },
      );
      const body = (await r.json().catch(() => ({}))) as { config?: MeetingRecordsConfig | null };
      if (r.ok) setMeetingConfig(body.config ?? null);
    } catch {
      // Soft-fail: the row just stays in "needs setup".
    }
  }, [workspace]);

  const loadCatalog = useCallback(async () => {
    try {
      const r = await fetch("/api/integrations/catalog", { cache: "no-store" });
      const body = (await r.json().catch(() => ({}))) as { entries?: IntegrationCatalogEntry[] };
      if (r.ok && body.entries?.length) {
        setCatalog((prev) => {
          const next = new Map(prev);
          for (const entry of body.entries!) next.set(entry.key, entry);
          return next;
        });
      }
    } catch {
      // Native fallback already seeded.
    }
  }, []);

  const loadActivity = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const r = await fetch(`/api/integrations/activity?workspace_id=${encodeURIComponent(workspaceId)}`, { cache: "no-store" });
      if (!r.ok) return; // older API — rows simply never glow
      const body = (await r.json().catch(() => ({}))) as { activity?: IntegrationActivity[] };
      setActivity(new Map((body.activity ?? []).map((a) => [a.connector_id, a])));
    } catch {
      // Best-effort.
    }
  }, [workspaceId]);

  useEffect(() => {
    void loadInstalls();
    void loadMeetingConfig();
    void loadCatalog();
  }, [loadInstalls, loadMeetingConfig, loadCatalog]);

  useEffect(() => {
    if (!workspaceId) return;
    void loadActivity();
    const activityTimer = setInterval(() => void loadActivity(), ACTIVITY_POLL_MS);
    const installsTimer = setInterval(() => void loadInstalls(), INSTALLS_POLL_MS);
    return () => {
      clearInterval(activityTimer);
      clearInterval(installsTimer);
    };
  }, [workspaceId, loadActivity, loadInstalls]);

  useWorkspaceBroadcast("meeting_bot.status", (event) => {
    const payload = event.payload as MeetingBotStatusEvent;
    setMeetingLive(isLiveMeetingStatus(payload.status) ? payload.status : null);
  });

  // Meeting records is a row even before its first install (it is the one
  // integration every workspace starts with, gated behind its setup).
  const rows = useMemo(() => {
    const byId = new Map(installs.map((install) => [install.connector_id, install]));
    const list = [...installs];
    if (!byId.has("meeting-bot")) {
      list.unshift({ id: "meeting-bot", connector_id: "meeting-bot", status: meetingConfig ? "active" : "pending", config: {} });
    }
    return list;
  }, [installs, meetingConfig]);

  const runNow = useCallback(
    async (install: ConnectorInstall) => {
      if (!workspaceId) return;
      const title = catalog.get(install.connector_id)?.name ?? install.connector_id;
      try {
        const r = await fetch(`/api/connectors/${encodeURIComponent(install.connector_id)}/sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspace_id: workspaceId }),
        });
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(typeof body.error === "string" ? body.error : `HTTP ${r.status}`);
        }
        toast.info(`${title} run queued.`);
        // Glow immediately instead of waiting for the next poll.
        setActivity((prev) => {
          const next = new Map(prev);
          const existing = prev.get(install.connector_id);
          next.set(install.connector_id, {
            connector_id: install.connector_id,
            install_id: install.id,
            state: "fetching",
            running_jobs: existing?.running_jobs ?? 0,
            queued_jobs: (existing?.queued_jobs ?? 0) + 1,
            last_run_at: existing?.last_run_at ?? null,
            next_run_at: existing?.next_run_at ?? null,
            signals_today: existing?.signals_today ?? 0,
            candidates_today: existing?.candidates_today ?? 0,
          });
          return next;
        });
        setTimeout(() => void loadActivity(), 2_000);
      } catch (e) {
        toast.error(`Run failed: ${(e as Error).message}`);
      }
    },
    [workspaceId, catalog, toast, loadActivity],
  );

  if (!workspaceId) {
    return (
      <EmptyState className="mt-6 min-h-[320px] rounded-2xl border border-dashed border-[var(--line)] bg-[var(--paper-2)] px-6 py-12">
        <EmptyState.Header>
          <EmptyState.Media variant="icon">
            <Plug size={18} />
          </EmptyState.Media>
          <EmptyState.Title className="text-[16px] text-[var(--ink)]">Integrations need a persisted workspace</EmptyState.Title>
          <EmptyState.Description className="max-w-[430px]">
            The demo workspace has no pipeline. Create a real workspace and connect your tools to let Nexo grow the brain.
          </EmptyState.Description>
        </EmptyState.Header>
      </EmptyState>
    );
  }

  if (!loaded) return <IngestQueueSkeleton />;

  const configuringTitle = configuring ? catalog.get(configuring.connector_id)?.name ?? configuring.connector_id : "";

  return (
    <div>
      {error ? (
        <div role="alert" className="mt-3 rounded-md border border-red-500/30 bg-red-500/5 p-3 text-[12px] text-red-600">
          {error}
        </div>
      ) : null}

      <ul className="mt-5 flex list-none flex-col gap-3 p-0">
        {rows.map((install) => {
          const entry = catalog.get(install.connector_id);
          const isMeeting = install.connector_id === "meeting-bot";
          const live = activity.get(install.connector_id) ?? null;
          const working = isMeeting
            ? meetingLive !== null
            : live !== null && (live.state === "fetching" || live.state === "processing");
          return (
            <IntegrationRow
              key={install.id}
              install={install}
              name={entry?.name ?? install.connector_id}
              logoUrl={entry?.logo_url ?? null}
              working={working}
              liveLabel={
                isMeeting
                  ? meetingLive
                    ? meetingLive === "in_call"
                      ? "Recording…"
                      : `${meetingLive.replace(/_/g, " ")}…`
                    : null
                  : live?.state === "fetching"
                    ? "Fetching…"
                    : live?.state === "processing"
                      ? "Nexo is processing…"
                      : null
              }
              statusLabel={isMeeting ? (meetingConfig ? "active" : "needs setup") : install.status}
              statusTone={
                isMeeting
                  ? meetingConfig
                    ? "ok"
                    : "warn"
                  : install.status === "active"
                    ? "ok"
                    : install.status === "errored"
                      ? "error"
                      : "warn"
              }
              activity={live}
              whatFor={
                isMeeting
                  ? meetingConfig?.objective ?? ""
                  : typeof install.config.ingest_guidance === "string"
                    ? install.config.ingest_guidance
                    : ""
              }
              whenLabel={isMeeting ? "Instant · on arrival" : cadenceText(install)}
              onConfigure={() => {
                if (isMeeting) setMeetingSetupOpen(true);
                else setConfiguring(install);
              }}
              extraAction={
                isMeeting && meetingConfig
                  ? { label: "Record", onPress: () => setRecordOpen(true) }
                  : null
              }
            />
          );
        })}
      </ul>

      {ownAppModal}

      {configuring ? (
        <ConfigureIntegrationModal
          workspaceId={workspaceId}
          install={configuring}
          entry={catalog.get(configuring.connector_id) ?? null}
          title={configuringTitle}
          onClose={() => setConfiguring(null)}
          onSaved={(next) => {
            setConfiguring(null);
            setInstalls((prev) => prev.map((i) => (i.id === next.id ? { ...i, ...next } : i)));
            toast.info(`${configuringTitle} saved.`);
          }}
          onRunNow={runNow}
          onReconnect={async (next) => {
            // Credentials changed: the connection was dropped server-side,
            // so run the connect flow again with the new OAuth app.
            setConfiguring(null);
            setInstalls((prev) => prev.map((i) => (i.id === next.id ? { ...i, ...next } : i)));
            const entry = catalog.get(next.connector_id);
            if (!entry) return;
            try {
              await install(entry);
            } catch (e) {
              toast.error((e as Error).message);
            }
          }}
          onDisconnected={(gone) => {
            setConfiguring(null);
            setInstalls((prev) => prev.filter((i) => i.id !== gone.id));
            toast.info(`${configuringTitle} disconnected.`);
          }}
        />
      ) : null}

      <MeetingRecordsSetupModal
        open={meetingSetupOpen}
        onClose={() => setMeetingSetupOpen(false)}
        workspace={workspace}
        existingConfig={meetingConfig}
        onConfigured={(next) => {
          setMeetingConfig(next);
          setMeetingSetupOpen(false);
          void loadInstalls();
        }}
      />
      {recordOpen ? <RecordMeetingModal open={recordOpen} onClose={() => setRecordOpen(false)} workspace={workspace} /> : null}
    </div>
  );
}

function cadenceText(install: ConnectorInstall): string {
  const instant = (install.config.cadence as { mode?: string } | undefined)?.mode === "instant";
  if (instant) return "Instant · on arrival";
  const parsed = CadenceSchema.safeParse(install.config.cadence);
  return parsed.success ? cadenceLabel(parsed.data) : "Not scheduled";
}

function IntegrationRow({
  install,
  name,
  logoUrl,
  working,
  liveLabel,
  statusLabel,
  statusTone,
  activity,
  whatFor,
  whenLabel,
  onConfigure,
  extraAction,
}: {
  install: ConnectorInstall;
  name: string;
  logoUrl: string | null;
  working: boolean;
  liveLabel: string | null;
  statusLabel: string;
  statusTone: "ok" | "warn" | "error";
  activity: IntegrationActivity | null;
  whatFor: string;
  whenLabel: string;
  onConfigure: () => void;
  extraAction: { label: string; onPress: () => void } | null;
}) {
  const dot = statusTone === "ok" ? "var(--accent)" : statusTone === "error" ? "var(--danger, #dc2626)" : "var(--warn)";
  const meta: string[] = [];
  if (activity?.last_run_at) meta.push(`last run ${formatRelative(activity.last_run_at)}`);
  if (activity && activity.signals_today > 0) meta.push(`${activity.signals_today} signals today`);
  if (activity && activity.candidates_today > 0) meta.push(`${activity.candidates_today} learned today`);
  if (install.last_error && statusTone === "error") meta.push(install.last_error);

  return (
    <li
      className={cn(
        "fade-in relative flex flex-col gap-3 rounded-[12px] border border-[var(--line)] bg-[var(--paper)] p-4 transition-[border-color,box-shadow] duration-300 sm:flex-row sm:items-start",
        working ? "bx-aura" : "hover:border-[var(--ink-mute)]",
      )}
      data-working={working ? "true" : undefined}
    >
      <ProviderLogo name={name} logoUrl={logoUrl} connectorId={install.connector_id} />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="m-0 truncate text-[14px] font-medium leading-tight text-[var(--ink)]">{name}</h3>
          {working && liveLabel ? (
            <Chip size="sm" variant="soft" color="accent" className="gap-1.5">
              <LiveDot />
              {liveLabel}
            </Chip>
          ) : (
            <Chip size="sm" variant="soft" className="gap-1.5 capitalize">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: dot }} />
              {statusLabel}
            </Chip>
          )}
        </div>
        <p className={cn("m-0 mt-1.5 line-clamp-2 text-[12.5px] leading-[1.5]", whatFor ? "text-[var(--ink-2)]" : "italic text-[var(--ink-mute)]")}>
          {whatFor || "Tell Nexo what to learn from this integration"}
        </p>
        <div className="mono mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10.5px] text-[var(--ink-3)]">
          <span>{whenLabel}</span>
          {meta.map((m) => (
            <span key={m} className="truncate">
              {m}
            </span>
          ))}
        </div>
        {install.access ? <AccessLine access={install.access} /> : null}
      </div>

      <div className="flex shrink-0 items-center gap-1 self-end sm:self-start">
        {extraAction ? (
          <Button size="sm" variant="ghost" onPress={extraAction.onPress} className="h-8 text-[12px] text-[var(--ink-2)]">
            {extraAction.label}
          </Button>
        ) : null}
        <Tooltip delay={400}>
          <Tooltip.Trigger>
            <Button
              size="sm"
              variant="ghost"
              isIconOnly
              aria-label={`Configure ${name}`}
              onPress={onConfigure}
              className="h-8 w-8 text-[var(--ink-3)] hover:text-[var(--ink)]"
            >
              <Settings2 size={15} />
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>Configure</Tooltip.Content>
        </Tooltip>
      </div>
    </li>
  );
}

/**
 * What the bot can search (Slack installs only): the reach as a mono chip
 * and the API's one-line note. Quiet on purpose — ink-3, one line, no
 * control yet; an admin narrows the grant elsewhere.
 */
function AccessLine({ access }: { access: ConnectorInstallAccess }) {
  return (
    <p className="m-0 mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] leading-[1.5] text-[var(--ink-3)]">
      <span className="mono inline-flex h-[18px] items-center rounded-full border border-[var(--line)] bg-[var(--paper-2)] px-2 text-[10.5px] leading-none text-[var(--ink-2)]">
        {access.reach}
      </span>
      <span>{access.note}</span>
      {access.reach === "unscoped" ? (
        <span className="text-[var(--ink-mute)]">An admin can narrow what it sees.</span>
      ) : null}
    </p>
  );
}

function LiveDot() {
  return (
    <span aria-hidden="true" className="relative flex h-2 w-2 shrink-0">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--accent)] opacity-60" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--accent)]" />
    </span>
  );
}
