"use client";

/**
 * The body of a task or bug in the panel: what blocks it and what it
 * blocks, its subtasks, then its prose. Status and priority live in the
 * identity strip above (`node-inspector.tsx`); this is everything under it.
 *
 * Dependencies come from the inspector payload's `blocked_by` / `blocks`
 * (typed `blocked_by` edges) and open the other node in the panel. They
 * are read here, not edited: the REST surface has no route for edges yet
 * (agents write them with `links_write` over MCP), so the panel shows them
 * with their current state and nothing more.
 *
 * Subtasks wrap the prose: the list sits under it, and opening a step
 * shows that step's content in place of both. The subtask write path hands
 * the server's node back so the panel's `updated_at` stays current for the
 * next guarded patch, and ships the recount to boards and peers.
 */

import { Link2, Lock, Unlock } from "lucide-react";
import { SubtasksSection } from "@/components/subtasks-section";
import { nodeKindIcon } from "@/components/node-kind-icon";
import type { InspectorDependency } from "@bcontext-dev/contract/node-inspector";
import { statusLabel } from "@bcontext-dev/contract/types";
import { cn } from "@bcontext-dev/contract/utils";
import { STATUS_DOT } from "./property-select";
import { PanelProse } from "./prose-body";
import type { PanelBodyProps } from "./panel-body";

export function WorkBody(props: PanelBodyProps) {
  const { payload, workspace, canWrite, openNode, onWritten, onConflict } = props;
  const node = payload.node;
  const { blocked_by: blockedBy, blocks, unblocked } = payload.dependencies;
  const hasDependencies = blockedBy.length > 0 || blocks.length > 0;

  return (
    <div className="flex flex-col gap-5">
      {hasDependencies ? (
        <section aria-label="Dependencies" className="flex flex-col gap-2" data-testid="dependencies">
          {blockedBy.length > 0 ? (
            <DependencyList
              title={unblocked ? "Was blocked by" : "Blocked by"}
              icon={unblocked ? Unlock : Lock}
              tone={unblocked ? "muted" : "warn"}
              entries={blockedBy}
              onOpen={openNode}
            />
          ) : null}
          {blocks.length > 0 ? (
            <DependencyList title="Blocks" icon={Link2} tone="muted" entries={blocks} onOpen={openNode} />
          ) : null}
        </section>
      ) : null}
      <SubtasksSection
        workspace={workspace}
        node={node}
        canWrite={canWrite}
        onOpenNode={openNode}
        onConflict={onConflict}
        onWritten={onWritten}
      >
        <PanelProse {...props} />
      </SubtasksSection>
    </div>
  );
}

function DependencyList({
  title,
  icon: Icon,
  tone,
  entries,
  onOpen,
}: {
  title: string;
  icon: typeof Lock;
  tone: "warn" | "muted";
  entries: InspectorDependency[];
  onOpen: (id: string, blockId: string | null) => void;
}) {
  const TaskIcon = nodeKindIcon("task");
  return (
    <div>
      <div className={cn("mono flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.08em]", tone === "warn" ? "text-[var(--ink-2)]" : "text-[var(--ink-mute)]")}>
        <Icon size={11} />
        <span>{title}</span>
        <span className="text-[var(--ink-3)]">{entries.length}</span>
      </div>
      <ul className="mt-1 -mx-1">
        {entries.map((entry) => (
          <li key={entry.node_id}>
            <button
              type="button"
              onClick={() => onOpen(entry.node_id, null)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--paper-3)]"
            >
              <TaskIcon size={12} className="shrink-0 text-[var(--ink-3)]" />
              <span className={cn("min-w-0 flex-1 truncate text-[12.5px]", entry.done ? "text-[var(--ink-3)] line-through decoration-[var(--line-strong)]" : "text-[var(--ink)]")}>
                {entry.title ?? entry.node_id}
              </span>
              {entry.status ? (
                <span className="mono inline-flex shrink-0 items-center gap-1 text-[9.5px] text-[var(--ink-mute)]">
                  <i aria-hidden className="size-1.5 rounded-full" style={{ background: STATUS_DOT[entry.status] ?? "var(--ink-mute)" }} />
                  {statusLabel(entry.status)}
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
