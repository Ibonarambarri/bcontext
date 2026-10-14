"use client";

/**
 * Everything a node is connected to, as one list: backlinks, forward
 * mentions, typed relations and dependencies, each row opening the other
 * node in the panel. `buildConnections` folds the inspector payload into
 * rows; `ConnectionsList` draws them. The panel's Details door shows the
 * list for every kind; the entity body shows it up front, because an entity
 * is mostly what refers to it.
 */

import { Network } from "lucide-react";
import { nodeKindIcon } from "@/components/node-kind-icon";
import type { NodeInspectorPayload } from "@bcontext-dev/contract/node-inspector";
import type { KnowledgeNode } from "@bcontext-dev/contract/types";

export interface ConnectionRow {
  key: string;
  id: string;
  title: string;
  kind: KnowledgeNode["kind"] | null;
  label: string;
  blockId: string | null;
}

/** "supersedes"/"superseded by" reads clearer than a raw arrow + relation name. */
function relationLabel(relation: NodeInspectorPayload["relations"][number]): string {
  if (relation.relation === "supersedes") {
    return relation.direction === "outgoing" ? "supersedes" : "superseded by";
  }
  return `${relation.direction === "outgoing" ? "→" : "←"} ${relation.relation}`;
}

export function buildConnections(payload: NodeInspectorPayload): ConnectionRow[] {
  return [
    ...payload.backlinks.map((entry) => ({ key: `in:${entry.id}:${entry.block_id ?? ""}`, id: entry.id, title: entry.title, kind: entry.kind as KnowledgeNode["kind"], label: "references this", blockId: entry.block_id })),
    ...payload.forward_links.map((entry) => ({ key: `out:${entry.id}:${entry.block_id ?? ""}`, id: entry.id, title: entry.title, kind: entry.kind as KnowledgeNode["kind"], label: "mentioned here", blockId: entry.block_id })),
    ...payload.relations.map((relation) => ({ key: `rel:${relation.from_node}:${relation.to_node}:${relation.relation}`, id: relation.node_id, title: relation.title ?? relation.node_id, kind: relation.kind, label: relationLabel(relation), blockId: null })),
    ...payload.dependencies.blocked_by.map((dependency) => ({ key: `by:${dependency.node_id}`, id: dependency.node_id, title: dependency.title ?? dependency.node_id, kind: "task" as const, label: dependency.done ? "was blocked by" : "blocked by", blockId: null })),
    ...payload.dependencies.blocks.map((dependency) => ({ key: `blocks:${dependency.node_id}`, id: dependency.node_id, title: dependency.title ?? dependency.node_id, kind: "task" as const, label: "blocks", blockId: null })),
  ];
}

export function ConnectionsList({
  connections,
  onOpen,
  emptyText = "Nothing links here yet. Mention this node with @ in another node, or add a relation from an agent.",
}: {
  connections: ConnectionRow[];
  onOpen: (id: string, blockId: string | null) => void;
  emptyText?: string;
}) {
  if (connections.length === 0) {
    return <p className="mt-1.5 text-[12px] text-[var(--ink-3)]">{emptyText}</p>;
  }
  return (
    <ul className="mt-1.5 -mx-1">
      {connections.map((entry) => {
        const Icon = entry.kind ? nodeKindIcon(entry.kind) : Network;
        return (
          <li key={entry.key}>
            <button
              type="button"
              onClick={() => onOpen(entry.id, entry.blockId)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--paper-3)]"
            >
              <Icon size={12} className="shrink-0 text-[var(--ink-3)]" />
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--ink)]">{entry.title}</span>
              <span className="mono shrink-0 text-[9.5px] text-[var(--ink-mute)]">{entry.label}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
