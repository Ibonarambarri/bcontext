"use client";

/**
 * One conflict, in full — the floating panel `conflicts-view.tsx` opens for
 * a row, the same window a node opens in (`floating-panel.tsx`: half of the
 * surface, expandable, beside Nexo, Esc closes) so the two read as one
 * thing. Header and body follow `node-inspector.tsx` — kind chip and date
 * in the chrome row, the title in the identity strip, the content in the
 * scroll below; only the footer is its own, because a conflict has two
 * actions and a node has none.
 *
 * Inside: NEXO's context (markdown), the exact quotes it saw, the nodes
 * involved (fetched on open; they open on top of this panel) and the
 * decision field. "Send to NEXO" is optimistic (the row leaves the open
 * list at once; a failure brings it back with a toast); Dismiss likewise —
 * `POST /api/nexo/conflicts/:id/{resolve,dismiss}`.
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, Ban, ExternalLink, Maximize2, Minimize2, Send, X } from "lucide-react";
import { Button, Chip, Label, ScrollShadow, Spinner, TextArea, TextField } from "@heroui/react";
import { FloatingPanel, FloatingPanelAction } from "@/components/floating-panel";
import { NodeMarkdown } from "@/components/node-markdown";
import { NodeLink } from "@/components/node-open-link";
import { useWorkspace } from "@/components/workspace-context";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { conflictKindTone } from "./conflict-kind";
import { CONFLICT_KIND_LABELS, type NexoConflict, type RelatedNodeSummary } from "@/lib/integrations/types";
import { nodeDeepLink } from "@/lib/view-shell";
import { formatRelative } from "@bcontext-dev/contract/utils";
import type { WorkspaceAddress } from "@/web/workspace-url";

export function ConflictPanel({
  workspace,
  workspaceId,
  conflict,
  onClose,
  onResolved,
  onDismissed,
  onFailed,
}: {
  workspace: WorkspaceAddress;
  workspaceId: string;
  conflict: NexoConflict | null;
  onClose: () => void;
  onResolved: (next: NexoConflict) => void;
  onDismissed: (next: NexoConflict) => void;
  onFailed: (message: string) => void;
}) {
  // Same half/full preference as the node panel: one window, one setting.
  const { nodePanelSize, setNodePanelSize } = useWorkspace();
  const isMobile = useIsMobile();
  const full = isMobile || nodePanelSize === "full";

  const [decision, setDecision] = useState("");
  const [related, setRelated] = useState<RelatedNodeSummary[]>([]);
  const [sending, setSending] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [result, setResult] = useState<NexoConflict["resolution"]>(null);

  // Fresh panel per conflict: reset the field and load the related nodes.
  useEffect(() => {
    setDecision(conflict?.decision_text ?? "");
    setResult(conflict?.resolution ?? null);
    setRelated([]);
    if (!conflict) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(
          `/api/nexo/conflicts/${encodeURIComponent(conflict.id)}?workspace_id=${encodeURIComponent(workspaceId)}`,
          { cache: "no-store" },
        );
        const body = (await r.json().catch(() => ({}))) as { related_nodes?: RelatedNodeSummary[] };
        if (r.ok && !cancelled) setRelated(body.related_nodes ?? []);
      } catch {
        // The ids still render as links.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conflict, workspaceId]);

  const isOpen = conflict !== null;
  const settled = conflict?.status !== "open";
  const busy = sending || dismissing;

  async function send() {
    if (!conflict || decision.trim().length === 0) return;
    setSending(true);
    const optimistic: NexoConflict = {
      ...conflict,
      status: "resolved",
      decision_text: decision.trim(),
      resolved_at: new Date().toISOString(),
    };
    try {
      const r = await fetch(`/api/nexo/conflicts/${encodeURIComponent(conflict.id)}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId, decision: decision.trim() }),
      });
      const body = (await r.json().catch(() => ({}))) as { conflict?: NexoConflict; error?: string; message?: string };
      if (!r.ok) throw new Error(body.message ?? (typeof body.error === "string" ? body.error : `HTTP ${r.status}`));
      const next = body.conflict ?? optimistic;
      setResult(next.resolution);
      onResolved(next);
    } catch (e) {
      onFailed(`NEXO could not apply the decision: ${(e as Error).message}`);
    } finally {
      setSending(false);
    }
  }

  async function dismiss() {
    if (!conflict) return;
    setDismissing(true);
    try {
      const r = await fetch(`/api/nexo/conflicts/${encodeURIComponent(conflict.id)}/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId }),
      });
      const body = (await r.json().catch(() => ({}))) as { conflict?: NexoConflict; error?: string; message?: string };
      if (!r.ok) throw new Error(body.message ?? (typeof body.error === "string" ? body.error : `HTTP ${r.status}`));
      onDismissed(body.conflict ?? { ...conflict, status: "dismissed" });
      onClose();
    } catch (e) {
      onFailed(`Could not dismiss: ${(e as Error).message}`);
    } finally {
      setDismissing(false);
    }
  }

  // A request in flight keeps the panel: closing would drop its outcome.
  const close = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);

  // z-20: under the node panel (z-30), so a related node opened from here
  // covers the conflict and closing it brings the conflict back. The view
  // lives in a scroll container, hence the portal to the shell's region.
  return (
    <FloatingPanel
      open={isOpen}
      size={full ? "full" : "half"}
      label={conflict ? `Conflict: ${conflict.summary}` : "Conflict"}
      onClose={close}
      portal
      data-conflict-panel
      className="z-20"
    >
      {conflict ? (
        <div className="flex h-full min-h-0 flex-col">
          <header className="flex min-h-12 items-center gap-2 border-b border-[var(--line)] px-3 py-2">
            <Chip
              size="sm"
              variant="soft"
              color={conflictKindTone(conflict.kind)}
              className="mono rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider"
            >
              <Chip.Label>{CONFLICT_KIND_LABELS[conflict.kind]}</Chip.Label>
            </Chip>
            <span className="mono truncate text-[10px] text-[var(--ink-mute)]">{formatRelative(conflict.created_at)}</span>
            <span className="ml-auto" />
            <div className="flex items-center gap-0.5">
              {!isMobile ? (
                <FloatingPanelAction label={full ? "Shrink to half" : "Expand"} onPress={() => setNodePanelSize(full ? "half" : "full")}>
                  {full ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                </FloatingPanelAction>
              ) : null}
              <FloatingPanelAction label="Close" disabled={busy} onPress={close}><X size={13} /></FloatingPanelAction>
            </div>
          </header>

          <div className="border-b border-[var(--line)] px-5 pb-3 pt-4">
            <h2 className="m-0 text-[21px] font-semibold leading-tight tracking-[-0.01em]">{conflict.summary}</h2>
          </div>

          <ScrollShadow className="scroll min-h-0 flex-1 px-5 py-4">
            <div className="flex flex-col gap-5 pb-6">
              <section aria-label="Context">
                <NodeMarkdown markdown={conflict.context_md} className="text-[13px] leading-[1.6]" />
              </section>

              {conflict.evidence.length > 0 ? (
                <section aria-label="Evidence" className="flex flex-col gap-2">
                  <h4 className="m-0 text-[11px] font-medium uppercase tracking-wide text-[var(--ink-3)]">What NEXO saw</h4>
                  {conflict.evidence.map((item, index) => (
                    <blockquote
                      key={`${item.source}-${item.external_id ?? index}`}
                      className="m-0 rounded-[10px] border-l-2 border-[var(--line-strong)] bg-[var(--paper-2)] px-3 py-2"
                    >
                      <p className="m-0 text-[12.5px] italic leading-[1.5] text-[var(--ink-2)]">“{item.excerpt}”</p>
                      <div className="mono mt-1 flex items-center gap-2 text-[10.5px] text-[var(--ink-3)]">
                        <span>{item.source}</span>
                        {item.at ? <span>· {formatRelative(item.at)}</span> : null}
                        {item.url ? (
                          <a href={item.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-[var(--ink-2)] no-underline hover:underline">
                            open <ExternalLink size={10} />
                          </a>
                        ) : null}
                      </div>
                    </blockquote>
                  ))}
                </section>
              ) : null}

              {conflict.related_node_ids.length > 0 ? (
                <section aria-label="Related nodes" className="flex flex-col gap-1.5">
                  <h4 className="m-0 text-[11px] font-medium uppercase tracking-wide text-[var(--ink-3)]">In the brain</h4>
                  <ul className="m-0 flex list-none flex-col gap-1 p-0">
                    {conflict.related_node_ids.map((id) => {
                      const node = related.find((n) => n.id === id);
                      return (
                        <li key={id}>
                          <NodeLink
                            href={nodeDeepLink(workspace, id)}
                            nodeId={id}
                            className="inline-flex max-w-full items-center gap-1.5 text-[12.5px] text-[var(--ink)] no-underline hover:underline"
                          >
                            {node ? (
                              <>
                                <span className="mono shrink-0 text-[10px] text-[var(--ink-3)]">{node.kind}</span>
                                <span className="truncate">{node.title}</span>
                              </>
                            ) : (
                              <span className="mono truncate text-[11px]">{id}</span>
                            )}
                            <ArrowUpRight size={11} className="shrink-0 text-[var(--ink-3)]" />
                          </NodeLink>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ) : null}

              {settled ? (
                <section aria-label="Resolution" className="rounded-[12px] border border-[var(--line)] bg-[var(--paper-2)] p-3">
                  <h4 className="m-0 text-[11px] font-medium uppercase tracking-wide text-[var(--ink-3)]">
                    {conflict.status === "dismissed" ? "Dismissed" : "Your decision"}
                  </h4>
                  {conflict.decision_text ? (
                    <p className="m-0 mt-1 text-[12.5px] leading-[1.5] text-[var(--ink)]">{conflict.decision_text}</p>
                  ) : null}
                  {result ? <ResolutionSummary resolution={result} workspace={workspace} /> : null}
                </section>
              ) : (
                <section aria-label="Your decision">
                  <TextField value={decision} onChange={setDecision} isDisabled={busy} className="block">
                    <Label className="block text-[11px] text-[var(--ink-3)]">Your decision</Label>
                    <TextArea
                      rows={4}
                      placeholder="e.g. The new date is right — the launch moved to October. Update the decision and mark the old one superseded."
                      className="mt-1 w-full resize-none rounded-md border border-[var(--line)] bg-[var(--paper-2)] p-2 text-[12.5px] outline-none focus:border-[var(--line-strong)]"
                    />
                  </TextField>
                  <p className="m-0 mt-1.5 text-[11px] leading-[1.5] text-[var(--ink-3)]">
                    NEXO reads this, applies it to the brain and shows you what it changed.
                  </p>
                  {result ? <ResolutionSummary resolution={result} workspace={workspace} /> : null}
                </section>
              )}
            </div>
          </ScrollShadow>

          {!settled ? (
            <footer className="flex items-center gap-2 border-t border-[var(--line)] px-5 py-3">
              <Button variant="ghost" size="sm" isDisabled={busy} onPress={() => void dismiss()} className="gap-1.5 text-[var(--ink-2)]">
                {dismissing ? <Spinner size="sm" color="current" /> : <Ban size={12} />}
                Dismiss
              </Button>
              <span className="flex-1" />
              <Button size="sm" isDisabled={busy || decision.trim().length === 0} onPress={() => void send()} className="gap-1.5">
                {sending ? <Spinner size="sm" color="current" /> : <Send size={12} />}
                {sending ? "Sending…" : "Send to NEXO"}
              </Button>
            </footer>
          ) : null}
        </div>
      ) : null}
    </FloatingPanel>
  );
}

function ResolutionSummary({ resolution, workspace }: { resolution: NonNullable<NexoConflict["resolution"]>; workspace: WorkspaceAddress }) {
  return (
    <div className="mt-2 rounded-[10px] border border-[var(--line)] bg-[var(--paper)] p-3">
      <p className="m-0 text-[12.5px] leading-[1.5] text-[var(--ink)]">{resolution.summary}</p>
      {resolution.actions.length > 0 ? (
        <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
          {resolution.actions.map((action, index) => (
            <li key={`${action.op}-${action.node_id ?? index}`} className="mono flex items-center gap-2 text-[11px] text-[var(--ink-2)]">
              <span className="rounded bg-[var(--paper-2)] px-1.5 py-0.5 text-[10px] uppercase">{action.op}</span>
              {action.node_id ? (
                <NodeLink href={nodeDeepLink(workspace, action.node_id)} nodeId={action.node_id} className="inline-flex items-center gap-1 truncate no-underline hover:underline">
                  {action.title ?? action.node_id}
                  <ArrowUpRight size={10} />
                </NodeLink>
              ) : (
                <span className="truncate">{action.title ?? ""}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
