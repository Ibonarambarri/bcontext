"use client";

/**
 * Status (and, for work kinds, priority) pickers on the `/n/<id>` node
 * page — the same pills the floating panel's identity strip uses
 * (`node-panel/property-select.tsx`), so a task reads the same on its page
 * as in the panel. Rendered for every kind whose plan offers the task
 * vocabulary: tasks and bugs with priority, decisions and ADRs without.
 * Optimistic `PATCH /api/nodes/:id` guarded by `if_updated_at` (a 409
 * re-reads the node instead of overwriting); the confirmed fields are
 * folded into the workspace context so boards and lists converge without
 * a refetch.
 */

import { useState } from "react";
import {
  isGoalStatus,
  statusLabel,
  type KnowledgeNode,
  type Priority,
  type TaskStatus,
} from "@bcontext-dev/contract/types";
import { newestUpdatedAt } from "@/lib/newest-updated-at";
import {
  PRIORITIES,
  PRIORITY_DOT,
  PropertySelect,
  STATUS_DOT,
  TASK_STATUSES,
  isTaskStatus,
} from "@/components/node-panel/property-select";
import { useWorkspace } from "./workspace-context";
import { workspaceApiRef } from "@/web/workspace-url";

export function TaskInspector({ node, showPriority = true }: { node: KnowledgeNode; showPriority?: boolean }) {
  const { address, nodes, patchNodeSummary, toast } = useWorkspace();
  // The status column is shared with goals, so the seed is guarded rather
  // than cast: a node carrying `on_track` is not a task, and must not
  // silently open a picker that would rewrite it to "To do".
  const [status, setStatus] = useState<TaskStatus | null>(
    node.status && !isGoalStatus(node.status) ? node.status : null,
  );
  const [priority, setPriority] = useState<Priority | null>(node.priority);
  const [saving, setSaving] = useState(false);

  // The freshest `updated_at` this client knows, sent as `if_updated_at` so
  // a save never lands on top of an edit made elsewhere. The workspace
  // overlay is where every confirmed write here folds, and where the
  // editor's saves and peers' `node.updated` broadcasts land too, so
  // changing status right after editing the body does not read as a
  // conflict. The page's server render is the fallback.
  const updatedAt = newestUpdatedAt(
    nodes.find((candidate) => candidate.id === node.id)?.updated_at,
    node.updated_at,
  );

  // Optimistic per the product convention: the picker changes instantly, the
  // PATCH runs in background; on failure the visual change reverts and a
  // toast explains. A 409 means someone else wrote first: revert, re-read
  // the node so the pickers show what is actually stored, and let the
  // person pick again.
  async function save(patch: Partial<KnowledgeNode>, revert: () => void) {
    setSaving(true);
    try {
      const response = await fetch(`/api/nodes/${encodeURIComponent(node.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace: workspaceApiRef(address), ...(updatedAt ? { if_updated_at: updatedAt } : {}), ...patch }),
      });
      if (response.status === 409) {
        revert();
        await reload();
        toast.error("This node changed elsewhere. Showing the latest values — pick again.");
        return;
      }
      if (!response.ok) {
        revert();
        toast.error("Couldn't save the change. It was reverted.");
        return;
      }
      const body = (await response.json()) as { node?: KnowledgeNode };
      if (body.node) fold(body.node);
    } catch {
      revert();
      toast.error("Couldn't save the change. It was reverted.");
    } finally {
      setSaving(false);
    }
  }

  async function reload() {
    try {
      const response = await fetch(
        `/api/nodes/${encodeURIComponent(node.id)}?workspace=${encodeURIComponent(workspaceApiRef(address))}`,
        { cache: "no-store" },
      );
      if (!response.ok) return;
      const body = (await response.json()) as { node?: KnowledgeNode };
      if (!body.node) return;
      setStatus(body.node.status && !isGoalStatus(body.node.status) ? body.node.status : null);
      setPriority(body.node.priority);
      fold(body.node);
    } catch {
      // The toast already said the node moved on; the next save will 409
      // again if this read failed, which is the safe outcome.
    }
  }

  function fold(current: KnowledgeNode) {
    patchNodeSummary(node.id, {
      status: current.status,
      priority: current.priority,
      updated_at: current.updated_at,
    });
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <PropertySelect
        label="Status"
        value={status ?? ""}
        disabled={saving}
        options={[{ value: "", label: "None" }, ...TASK_STATUSES.map((value) => ({ value, label: statusLabel(value) }))]}
        dots={STATUS_DOT}
        onChange={(value) => {
          const next = value && isTaskStatus(value) ? value : null;
          if (next === status) return;
          const previous = status;
          setStatus(next);
          void save({ status: next }, () => setStatus(previous));
        }}
      />
      {showPriority ? (
        <PropertySelect
          label="Priority"
          value={priority ?? ""}
          disabled={saving}
          options={[{ value: "", label: "None" }, ...PRIORITIES.map((value) => ({ value, label: value }))]}
          dots={PRIORITY_DOT}
          onChange={(value) => {
            const next = (value || null) as Priority | null;
            if (next === priority) return;
            const previous = priority;
            setPriority(next);
            void save({ priority: next }, () => setPriority(previous));
          }}
        />
      ) : null}
    </div>
  );
}
