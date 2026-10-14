"use client";

/**
 * Conflicts — everything NEXO is not sure about; the `conflicts` system
 * view, mounted through `agents-dashboard.tsx`. Reads
 * `GET /api/nexo/conflicts` by status and polls it while mounted. NEXO
 * writes what it is confident about straight into the
 * brain; a contradiction with existing knowledge that does not announce a
 * change, a low-confidence candidate, or knowledge that looks stale lands
 * here instead. Each row is one line; the floating panel (the node
 * panel's window) carries the context and the decision field. Sending a decision hands it to NEXO, which applies it
 * and reports what it did.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCheck, ShieldQuestion } from "lucide-react";
import { Chip, Tabs } from "@heroui/react";
import { EmptyState } from "@/components/ui/empty-state";
import { ListSkeleton } from "@/components/skeletons";
import { useWorkspace } from "../workspace-context";
import { ConflictPanel } from "./conflict-panel";
import { conflictKindTone } from "./conflict-kind";
import { CONFLICT_KIND_LABELS, type NexoConflict, type NexoConflictStatus } from "@/lib/integrations/types";
import { cn, formatRelative } from "@bcontext-dev/contract/utils";
import type { WorkspaceAddress } from "@/web/workspace-url";

const POLL_MS = 20_000;
type Filter = Extract<NexoConflictStatus, "open" | "resolved">;

export function ConflictsView({ workspace }: { workspace: WorkspaceAddress }) {
  const { workspace: current, toast, closeNode } = useWorkspace();
  const workspaceId = current?.id ?? null;

  const [filter, setFilter] = useState<Filter>("open");
  const [conflicts, setConflicts] = useState<NexoConflict[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const r = await fetch(
        `/api/nexo/conflicts?workspace_id=${encodeURIComponent(workspaceId)}&status=${filter}`,
        { cache: "no-store" },
      );
      if (r.status === 404) {
        // An API build without this route reads as an empty inbox, not an
        // error banner.
        setConflicts([]);
        setError(null);
        return;
      }
      const body = (await r.json().catch(() => ({}))) as { conflicts?: NexoConflict[]; error?: string };
      if (!r.ok) throw new Error(typeof body.error === "string" ? body.error : `HTTP ${r.status}`);
      setConflicts(body.conflicts ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, [workspaceId, filter]);

  useEffect(() => {
    setLoaded(false);
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const open = useMemo(() => conflicts.find((c) => c.id === openId) ?? null, [conflicts, openId]);

  const applyLocal = useCallback((next: NexoConflict) => {
    setConflicts((prev) => prev.map((c) => (c.id === next.id ? next : c)));
  }, []);

  const removeLocal = useCallback((id: string) => {
    setConflicts((prev) => prev.filter((c) => c.id !== id));
  }, []);

  if (!workspaceId) {
    return (
      <EmptyState className="mt-6 min-h-[320px] rounded-2xl border border-dashed border-[var(--line)] bg-[var(--paper-2)] px-6 py-12">
        <EmptyState.Header>
          <EmptyState.Media variant="icon">
            <ShieldQuestion size={18} />
          </EmptyState.Media>
          <EmptyState.Title className="text-[16px] text-[var(--ink)]">Conflicts need a persisted workspace</EmptyState.Title>
          <EmptyState.Description className="max-w-[430px]">
            The demo workspace has no pipeline, so NEXO has nothing to doubt yet.
          </EmptyState.Description>
        </EmptyState.Header>
      </EmptyState>
    );
  }

  return (
    <div className="mt-1">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="m-0 max-w-[560px] text-[12.5px] leading-[1.55] text-[var(--ink-3)]">
          What NEXO could not settle on its own. Open one, read both sides, write your decision — NEXO applies it.
        </p>
        <Tabs selectedKey={filter} onSelectionChange={(key) => setFilter(key as Filter)}>
          <Tabs.ListContainer className="rounded-none bg-transparent">
            <Tabs.List aria-label="Conflict status" className="gap-1 bg-transparent p-0">
              <Tabs.Tab id="open" className="h-7 px-2.5 text-[12px]">
                Open
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="resolved" className="h-7 px-2.5 text-[12px]">
                Resolved
                <Tabs.Indicator />
              </Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
        </Tabs>
      </div>

      {error ? (
        <div role="alert" className="mt-3 rounded-md border border-red-500/30 bg-red-500/5 p-3 text-[12px] text-red-600">
          {error}
        </div>
      ) : null}

      {!loaded ? (
        <ListSkeleton rows={4} className="mt-5" />
      ) : conflicts.length === 0 ? (
        <EmptyState className="mt-5 min-h-[260px] rounded-2xl border border-dashed border-[var(--line)] bg-[var(--paper-2)] px-6 py-12">
          <EmptyState.Header>
            <EmptyState.Media variant="icon">
              {filter === "open" ? <CheckCheck size={18} /> : <ShieldQuestion size={18} />}
            </EmptyState.Media>
            <EmptyState.Title className="text-[16px] text-[var(--ink)]">
              {filter === "open" ? "Nothing to settle" : "No resolved conflicts yet"}
            </EmptyState.Title>
            <EmptyState.Description className="max-w-[430px]">
              {filter === "open"
                ? "NEXO is confident about everything it has learned so far. Doubts and contradictions will show up here."
                : "Decisions you send to NEXO will be listed here with what it did."}
            </EmptyState.Description>
          </EmptyState.Header>
        </EmptyState>
      ) : (
        <ul className="mt-5 flex list-none flex-col gap-2 p-0">
          {conflicts.map((conflict) => (
            <ConflictRow
              key={conflict.id}
              conflict={conflict}
              onOpen={() => {
                // The node panel floats above the conflict panel; a node left
                // open would hide the conflict just opened.
                closeNode();
                setOpenId(conflict.id);
              }}
            />
          ))}
        </ul>
      )}

      <ConflictPanel
        workspace={workspace}
        workspaceId={workspaceId}
        conflict={open}
        onClose={() => setOpenId(null)}
        onResolved={(next) => {
          applyLocal(next);
          if (filter === "open") removeLocal(next.id);
          toast.info("Decision sent to NEXO.");
        }}
        onDismissed={(next) => {
          applyLocal(next);
          if (filter === "open") removeLocal(next.id);
          toast.info("Conflict dismissed.");
        }}
        onFailed={(message) => {
          toast.error(message);
          void load();
        }}
      />
    </div>
  );
}

function ConflictRow({ conflict, onOpen }: { conflict: NexoConflict; onOpen: () => void }) {
  const source = conflict.evidence[0]?.source;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          "fade-in flex w-full items-center gap-3 rounded-[12px] border border-[var(--line)] bg-[var(--paper)] px-4 py-3 text-left transition-colors",
          "cursor-[var(--cursor-interactive)] hover:border-[var(--ink-mute)] focus-visible:border-[var(--ink-mute)] focus-visible:outline-none",
        )}
      >
        <Chip size="sm" variant="soft" color={conflictKindTone(conflict.kind)} className="shrink-0">
          {CONFLICT_KIND_LABELS[conflict.kind]}
        </Chip>
        <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--ink)]">{conflict.summary}</span>
        <span className="mono shrink-0 text-[10.5px] text-[var(--ink-3)]">
          {source ? `${source} · ` : ""}
          {formatRelative(conflict.created_at)}
        </span>
      </button>
    </li>
  );
}
