"use client";

/**
 * The signed-webhook branch of "Add tool provider" (`tool-providers-view.tsx`).
 * `POST /api/webhooks/endpoints` answers with the signing secret exactly once;
 * this dialog is the only place it is ever shown, so it swaps to the reveal
 * in the same window instead of closing.
 */
import { useState } from "react";
import { ArrowLeft, Check, Copy, Plus, Webhook } from "lucide-react";
import { Button, Input as HeroInput, Modal, TextField } from "@heroui/react";
import { WEBHOOK_EVENT_TYPES, type WebhookEventType } from "@bcontext-dev/contract/webhooks/events";
import { cn } from "@bcontext-dev/contract/utils";

/** One endpoint as `GET /api/webhooks/endpoints` lists it — the secret is never part of it. */
export interface WebhookEndpointRow {
  id: string;
  workspace_id: string;
  url: string;
  event_types: WebhookEventType[];
  secret_prefix: string;
  paused: boolean;
  created_at: string;
  last_delivery_at: string | null;
}

/**
 * Add-a-signed-webhook step of the "Add tool provider" flow. Creates the
 * endpoint, then swaps to the one-time secret reveal inside the same dialog.
 */
export function WebhookModal({ workspaceId, onClose, onBack, onCreated }: {
  workspaceId: string;
  onClose: () => void;
  /** Returns to the provider-type selector step. */
  onBack: () => void;
  /** Called after a successful creation so the grid can refresh. */
  onCreated: () => void;
}) {
  const [url, setUrl] = useState("");
  const [selected, setSelected] = useState<Set<WebhookEventType>>(
    new Set<WebhookEventType>(["node.created", "node.updated"]),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ secret: string; url: string } | null>(null);

  function toggle(eventType: WebhookEventType) {
    const next = new Set(selected);
    if (next.has(eventType)) next.delete(eventType);
    else next.add(eventType);
    setSelected(next);
  }

  async function create() {
    const trimmed = url.trim();
    if (!trimmed || selected.size === 0 || saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/webhooks/endpoints", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId,
          url: trimmed,
          event_types: Array.from(selected),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        endpoint?: WebhookEndpointRow;
        secret?: string;
        message?: string;
      };
      if (!response.ok || !body.endpoint || !body.secret) {
        throw new Error(body.message ?? `HTTP ${response.status}`);
      }
      setReveal({ secret: body.secret, url: body.endpoint.url });
      onCreated();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const valid = url.trim().length > 0 && selected.size > 0;

  return (
    <Modal.Backdrop
      isOpen
      onOpenChange={(next) => { if (!next && !saving) onClose(); }}
      isDismissable={!saving}
    >
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog aria-labelledby="webhook-modal-title" className="sm:max-w-[640px]">
          <Modal.CloseTrigger />
          <Modal.Header className="gap-1">
            <Modal.Heading id="webhook-modal-title">{reveal ? "Webhook secret — copy now" : "Add signed webhook"}</Modal.Heading>
            <p className="text-[12.5px] leading-relaxed text-muted">{reveal ? "This is the only time the secret is shown." : "Deliver workspace events to your URL as CloudEvents v1.0, signed with HMAC-SHA256."}</p>
          </Modal.Header>

          {reveal ? (
            <SecretReveal secret={reveal.secret} url={reveal.url} onDone={onClose} />
          ) : (
            <>
              <Modal.Body className="space-y-5 pb-2">
                <label className="flex flex-col gap-1.5 text-[10.5px] text-[var(--ink-3)]">
                  Destination URL
                  <TextField aria-label="Destination URL" value={url} isDisabled={saving} onChange={setUrl}>
                    <HeroInput
                      autoFocus
                      type="url"
                      maxLength={1000}
                      placeholder="https://example.com/webhooks/bcontext"
                      className="h-9 w-full rounded-md border border-[var(--line)] bg-[var(--paper-2)] px-2.5 text-[12px] outline-none focus:border-[var(--ink-mute)] disabled:opacity-50"
                    />
                  </TextField>
                </label>

                <div>
                  <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.05em] text-[var(--ink-mute)]">Event types</div>
                  <div className="flex flex-wrap gap-1.5">
                    {WEBHOOK_EVENT_TYPES.map((eventType) => {
                      const active = selected.has(eventType);
                      return (
                        <Button
                          key={eventType}
                          aria-pressed={active}
                          isDisabled={saving}
                          onPress={() => toggle(eventType)}
                          variant="outline"
                          className={cn(
                            "h-auto min-w-0 rounded-md border px-2 py-1 font-mono text-[10px] font-normal",
                            active
                              ? "border-[var(--ink)] bg-[var(--paper-2)] text-[var(--ink)]"
                              : "border-[var(--line)] text-[var(--ink-3)] hover:text-[var(--ink)]",
                          )}
                        >
                          {eventType}
                        </Button>
                      );
                    })}
                  </div>
                  {selected.size === 0 ? <p className="mt-2 text-[10.5px] text-[var(--ink-3)]">Pick at least one event type.</p> : null}
                </div>

                <div className="rounded-[10px] border border-[var(--line)] bg-[var(--paper-2)] p-3">
                  <div className="flex items-start gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--line)] bg-[var(--paper)]"><Webhook size={14} /></div>
                    <p className="min-w-0 flex-1 text-[10.5px] leading-relaxed text-[var(--ink-3)]">
                      Deliveries are signed with a per-endpoint secret (header{" "}
                      <code className="rounded bg-[var(--paper-3)] px-1 py-px font-mono text-[10px]">X-Signature: t=&lt;unix&gt;,v1=&lt;mac&gt;</code>
                      ). The secret is shown once after creation. Failed deliveries land in the DLQ.
                    </p>
                  </div>
                </div>

                {error ? <p className="rounded-md border border-danger/20 bg-danger/5 px-3 py-2 text-[11px] text-danger">{error}</p> : null}
              </Modal.Body>

              <Modal.Footer className="flex items-center gap-2">
                <Button isDisabled={saving} onPress={onBack} variant="ghost" size="sm" className="gap-1.5"><ArrowLeft size={13} /> Back</Button>
                <span className="ml-auto" />
                <Button isDisabled={saving} onPress={onClose} variant="outline" size="sm">Cancel</Button>
                <Button isDisabled={!valid || saving} onPress={() => void create()} size="sm" className="gap-1.5"><Plus size={12} />{saving ? "Creating…" : "Create endpoint"}</Button>
              </Modal.Footer>
            </>
          )}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function SecretReveal({ secret, url, onDone }: { secret: string; url: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  return (
    <>
      <Modal.Body className="space-y-4 pb-2">
        <div className="truncate font-mono text-[11px] text-[var(--ink-2)]">{url}</div>
        <div className="flex items-stretch gap-1.5">
          <code className="min-w-0 flex-1 overflow-x-auto rounded-md border border-[var(--line)] bg-[var(--paper-2)] px-2.5 py-2 font-mono text-[11px] text-[var(--ink)]">
            {secret}
          </code>
          <Button
            onPress={() => void copy()}
            aria-label="Copy secret"
            variant="outline"
            className="h-auto gap-1 rounded-md border-[var(--line)] bg-[var(--paper-2)] px-2.5 text-[11px] text-[var(--ink-2)] hover:bg-[var(--paper-3)] hover:text-[var(--ink)]"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <p className="text-[11px] leading-relaxed text-[var(--ink-3)]">
          Store this secret in your receiver. Verify each delivery by computing{" "}
          <code className="rounded bg-[var(--paper-3)] px-1 py-px font-mono text-[10px]">HMAC-SHA256(secret, &quot;${"{ts}"}.${"{body}"}&quot;)</code>{" "}
          and comparing against the{" "}
          <code className="rounded bg-[var(--paper-3)] px-1 py-px font-mono text-[10px]">v1</code>{" "}
          field.
        </p>
      </Modal.Body>
      <Modal.Footer className="flex items-center">
        <Button onPress={onDone} size="sm" className="ml-auto">Done</Button>
      </Modal.Footer>
    </>
  );
}
