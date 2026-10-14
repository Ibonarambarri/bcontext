"use client";

/**
 * "Connect with your own OAuth app" — the hybrid OAuth flow (spec
 * 2026-09-08). A workspace registers an OAuth app in the provider's console,
 * points it at Nango's callback, allows the listed scopes and pastes the
 * client id + secret here. The credentials go straight to the API, which
 * stores them in the self-hosted Nango instance as a per-workspace
 * integration; this component never keeps or renders the secret again.
 *
 * Two modes share the form: `connect` (marketplace → then the Connect UI
 * opens) and `replace` (Configure → swap the credentials of an existing
 * own-app install).
 */
import { useState } from "react";
import { Check, Copy, ExternalLink, KeyRound, Loader2 } from "lucide-react";
import { Button, Chip, Input, Label, Modal, TextField } from "@heroui/react";
import { ProviderLogo } from "./provider-logo";
import { useWorkspace } from "../workspace-context";
import { formatScopes, oauthCallbackUrl, uniqueScopes } from "@/lib/integrations/catalog";
import type { IntegrationCatalogEntry, IntegrationOAuthSetup, OwnOAuthAppInput } from "@/lib/integrations/types";
import { cn } from "@bcontext-dev/contract/utils";

const fieldClass =
  "mt-1 flex h-8 w-full items-center rounded-md border border-[var(--line)] bg-[var(--paper-2)] px-2 text-[12px] outline-none focus:border-[var(--line-strong)]";

export function OAuthAppModal({
  entry,
  setup,
  mode,
  onClose,
  onSubmit,
}: {
  entry: Pick<IntegrationCatalogEntry, "key" | "name" | "logo_url">;
  /** From the catalog entry, or from the 409 the install route answered with. */
  setup: IntegrationOAuthSetup | null | undefined;
  mode: "connect" | "replace";
  onClose: () => void;
  /** Resolves when the credentials were accepted; rejects with a message otherwise. */
  onSubmit: (input: OwnOAuthAppInput) => Promise<void>;
}) {
  const { toast } = useWorkspace();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const callback = oauthCallbackUrl(setup);
  const scopes = uniqueScopes(setup?.scopes);
  const consoleUrl = setup?.console_url?.trim() || null;
  const canSubmit = clientId.trim().length > 0 && clientSecret.trim().length > 0 && !submitting;

  async function copy(label: string, text: string) {
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      toast.info(`${label} copied.`);
    } catch {
      // No clipboard permission (or an insecure context): the text is
      // selectable on screen, so say so instead of failing silently.
      toast.error(`Could not copy the ${label.toLowerCase()} — select it and copy by hand.`);
    }
  }

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        client_id: clientId.trim(),
        client_secret: clientSecret.trim(),
        ...(scopes.length > 0 ? { scopes } : {}),
      });
      // Never keep the secret around once it left the form.
      setClientSecret("");
    } catch (e) {
      const message = (e as Error).message;
      if (message !== "closed") setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal.Backdrop
      isOpen
      onOpenChange={(next) => {
        if (!next && !submitting) onClose();
      }}
    >
      <Modal.Container placement="center" size="sm" scroll="inside">
        <Modal.Dialog aria-label={`Connect ${entry.name} with your own OAuth app`} className="w-full max-w-[520px]">
          <Modal.CloseTrigger />
          <Modal.Header className="gap-3">
            <div className="flex items-center gap-3">
              <ProviderLogo name={entry.name} logoUrl={entry.logo_url} connectorId={entry.key} size={36} />
              <div className="min-w-0">
                <Modal.Heading className="text-[15px] font-medium">
                  {mode === "replace" ? `Replace the OAuth app for ${entry.name}` : `Connect ${entry.name} with your own OAuth app`}
                </Modal.Heading>
                <p className="m-0 mt-0.5 text-[11.5px] leading-[1.5] text-[var(--ink-3)]">
                  Your organisation authorises through its own app. The credentials are stored encrypted in this
                  workspace&apos;s Nango instance, never in Bcontext.
                </p>
              </div>
            </div>
          </Modal.Header>

          <Modal.Body className="flex flex-col gap-4">
            {error ? (
              <div role="alert" className="rounded-md border border-red-500/30 bg-red-500/5 p-2 text-[11.5px] text-red-600">
                {error}
              </div>
            ) : null}

            <ol className="m-0 flex list-none flex-col gap-3 p-0">
              <Step n={1} title={consoleUrl ? "Create an OAuth app in the provider console" : "Create an OAuth app in your provider console"}>
                {consoleUrl ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="-ml-2 h-7 gap-1.5 text-[11.5px] text-[var(--ink-2)]"
                    onPress={() => window.open(consoleUrl, "_blank", "noopener,noreferrer")}
                  >
                    <ExternalLink size={11} /> Open {entry.name} developer console
                  </Button>
                ) : (
                  <p className="m-0 text-[11.5px] text-[var(--ink-3)]">
                    An internal app is enough — it does not need to be published or reviewed.
                  </p>
                )}
              </Step>

              <Step n={2} title="Add this callback URL to the app">
                <CopyRow label="Callback URL" value={callback} onCopy={() => void copy("Callback URL", callback)} mono />
              </Step>

              <Step n={3} title={scopes.length > 0 ? "Allow these scopes" : "Allow the scopes the provider requires"}>
                {scopes.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap gap-1">
                      {scopes.map((scope) => (
                        <Chip key={scope} size="sm" variant="soft" className="mono max-w-full text-[10.5px]">
                          <span className="truncate">{scope}</span>
                        </Chip>
                      ))}
                    </div>
                    <div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="-ml-2 h-7 gap-1.5 text-[11.5px] text-[var(--ink-2)]"
                        onPress={() => void copy("Scopes", formatScopes(scopes))}
                      >
                        <Copy size={11} /> Copy scopes
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="m-0 text-[11.5px] text-[var(--ink-3)]">Read access to what NEXO should learn from is enough.</p>
                )}
              </Step>

              <Step n={4} title="Paste the client ID and client secret">
                <div className="flex flex-col gap-2">
                  <TextField value={clientId} onChange={setClientId} className="block" isDisabled={submitting}>
                    <Label className="block text-[11px] text-[var(--ink-3)]">Client ID</Label>
                    <Input autoComplete="off" spellCheck={false} placeholder="e.g. 1234567890-abc.apps…" className={cn(fieldClass, "mono")} />
                  </TextField>
                  <TextField value={clientSecret} onChange={setClientSecret} className="block" isDisabled={submitting} type="password">
                    <Label className="block text-[11px] text-[var(--ink-3)]">Client secret</Label>
                    <Input autoComplete="new-password" spellCheck={false} placeholder="••••••••" className={cn(fieldClass, "mono")} />
                  </TextField>
                </div>
              </Step>
            </ol>
          </Modal.Body>

          <Modal.Footer className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-[10.5px] text-[var(--ink-mute)]">
              <KeyRound size={11} /> Only sent once, never shown again.
            </span>
            <span className="flex-1" />
            <Button variant="ghost" size="sm" isDisabled={submitting} onPress={onClose}>
              Cancel
            </Button>
            <Button size="sm" isDisabled={!canSubmit} onPress={() => void submit()} className="gap-1.5">
              {submitting ? <Loader2 size={12} className="animate-spin" /> : mode === "replace" ? <Check size={12} /> : null}
              {submitting ? (mode === "replace" ? "Saving…" : "Connecting…") : mode === "replace" ? "Save credentials" : "Connect"}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className="mono mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[var(--line)] bg-[var(--paper-2)] text-[10.5px] text-[var(--ink-2)]"
      >
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <p className="m-0 text-[12.5px] font-medium leading-tight text-[var(--ink)]">{title}</p>
        <div className="mt-1.5">{children}</div>
      </div>
    </li>
  );
}

function CopyRow({ label, value, onCopy, mono }: { label: string; value: string; onCopy: () => void; mono?: boolean }) {
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-[var(--line)] bg-[var(--paper-2)] pl-2">
      <code
        aria-label={label}
        className={cn("min-w-0 flex-1 select-all truncate py-1.5 text-[11.5px] text-[var(--ink-2)]", mono ? "mono" : "")}
      >
        {value}
      </code>
      <Button size="sm" variant="ghost" isIconOnly aria-label={`Copy ${label}`} onPress={onCopy} className="h-7 w-7 shrink-0 text-[var(--ink-3)]">
        <Copy size={12} />
      </Button>
    </div>
  );
}
