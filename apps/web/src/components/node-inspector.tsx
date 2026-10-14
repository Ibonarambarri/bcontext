"use client";

/**
 * The body of the floating node panel: what a selected node looks like
 * everywhere except its own `/n/<id>` page. `NodeInspectorSurface` is
 * mounted by `node-floating-panel.tsx`, which supplies the toolbar.
 *
 * Data: one `GET /api/nodes/:id/inspector` (node + permissions + backlinks,
 * relations, dependencies, provenance) plus the workspace's tag list for the
 * tag picker and inherited-tag display. Realtime `node.*`/`backlink.changed`
 * broadcasts trigger a background reload when they concern this node.
 *
 * Writes go through `patchNode`: optimistic on the payload, guarded by
 * `if_updated_at` (a 409 reloads and shows a conflict banner instead of
 * silently overwriting), and on success the summary is folded into the
 * workspace context AND broadcast, so boards, lists and peers converge
 * without a refetch. The guard uses the freshest `updated_at` this client
 * knows — the payload's or the workspace overlay's, whichever is newer —
 * because the bodies below write on their own (the editor's debounced
 * save, a subtask op, a key result) and fold the server's node back in
 * through `onWritten`.
 *
 * What sits under the identity strip is decided per kind by
 * `node-panel/body-for-kind.ts` and mounted by `node-panel/panel-body.tsx`:
 * the strip offers the status vocabulary and the priority pill the plan
 * says, the body is the kind's own (prose editor, task work, goal, meeting,
 * skill, entity, data grid, credential fields).
 */

import {
  AlertTriangle,
  ArrowLeft,
  Copy,
  Hash,
  Info,
  Loader2,
  LockKeyhole,
  RefreshCw,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Chip,
  Popover,
  ScrollShadow,
  Surface,
  Tooltip,
} from "@heroui/react";
import { DetailSkeleton } from "@/components/skeletons";
import { nodeSubtaskProgress } from "@bcontext-dev/contract/subtasks";
import { CardActionsMenu } from "@/components/card-actions-menu";
import { buildConnections, ConnectionsList } from "@/components/node-panel/connections";
import { panelPlanFor } from "@/components/node-panel/body-for-kind";
import { PanelBodyForKind } from "@/components/node-panel/panel-body";
import {
  PRIORITIES,
  PRIORITY_DOT,
  PropertySelect,
  STATUS_DOT,
  asNodeStatus,
  statusesFor,
} from "@/components/node-panel/property-select";
import { newestUpdatedAt } from "@/lib/newest-updated-at";
import { nodeActionsFor, useArchiveNode, useDeleteNode } from "@/components/node-actions";
import { useWorkspace, useToast } from "@/components/workspace-context";
import {
  descendantIds,
  shouldRefreshInspector,
  type NodeInspectorPayload,
} from "@bcontext-dev/contract/node-inspector";
import { ancestorsOfTags, type TagHierarchyRelation } from "@bcontext-dev/contract/tag-hierarchy";
import { useWorkspaceBroadcast, useWorkspaceRealtime } from "@/lib/collab/workspace-realtime";
import {
  statusLabel,
  type KnowledgeNode,
  type Priority,
  type WorkspaceTag,
} from "@bcontext-dev/contract/types";
import { formatRelative } from "@bcontext-dev/contract/utils";
import { PresenceAvatars } from "./collab/presence-avatars";
import { workspaceApiRef } from "@/web/workspace-url";

type InspectorError = "forbidden" | "missing" | "network";

/**
 * The shared node-detail body — everything from the header down. Rendered
 * by the floating node panel (`NodeFloatingPanel`), which supplies the
 * header `toolbar` (back/forward, size, open as page, close); `onClose` is
 * what the loading/error states use to dismiss.
 */
export function NodeInspectorSurface({
  nodeId,
  blockId,
  toolbar,
  onClose,
}: {
  nodeId: string;
  blockId: string | null;
  toolbar?: React.ReactNode;
  onClose: () => void;
}) {
  const {
    address,
    selectNode,
    nodes,
    duplicateNode,
    patchNodeSummary,
  } = useWorkspace();
  const toast = useToast();
  const realtime = useWorkspaceRealtime();
  const [payload, setPayload] = useState<NodeInspectorPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<InspectorError | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tags, setTags] = useState<WorkspaceTag[]>([]);
  const [tagRelations, setTagRelations] = useState<TagHierarchyRelation[]>([]);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [title, setTitle] = useState("");
  // Monotonic request id: a slow response for a node the panel has already
  // left must not overwrite the one now open.
  const requestRef = useRef(0);
  const archiveNode = useArchiveNode();
  const { request: requestDelete, dialog: deleteDialog } = useDeleteNode(() => onClose());

  const load = useCallback(async (background = false) => {
    if (!nodeId) return;
    const requestId = ++requestRef.current;
    if (background) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/nodes/${encodeURIComponent(nodeId)}/inspector?workspace=${encodeURIComponent(workspaceApiRef(address))}`,
        { cache: "no-store" },
      );
      if (requestRef.current !== requestId) return;
      if (response.status === 401 || response.status === 403) {
        setPayload(null);
        setError("forbidden");
        return;
      }
      if (response.status === 404) {
        setPayload(null);
        setError("missing");
        return;
      }
      if (!response.ok) throw new Error("inspector fetch failed");
      const next = (await response.json()) as NodeInspectorPayload;
      setPayload(next);
      setTitle(next.node.title);
    } catch {
      if (requestRef.current === requestId) setError("network");
    } finally {
      if (requestRef.current === requestId) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [nodeId, address]);

  useEffect(() => {
    setPayload(null);
    setConflict(false);
    if (nodeId) void load(false);
  }, [nodeId, load]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/tags?workspace=${encodeURIComponent(workspaceApiRef(address))}`, {
      cache: "no-store",
    })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((body: { tags?: WorkspaceTag[]; relations?: TagHierarchyRelation[] }) => {
        if (cancelled) return;
        setTags(body.tags ?? []);
        setTagRelations(body.relations ?? []);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [address]);

  const scheduleRealtimeRefresh = useCallback((kind: string, eventPayload: unknown) => {
    if (!nodeId) return;
    if (shouldRefreshInspector(kind, eventPayload, nodeId)) {
      void load(true);
    }
  }, [nodeId, load]);
  useWorkspaceBroadcast("node.updated", (event) => scheduleRealtimeRefresh("node.updated", event.payload));
  useWorkspaceBroadcast("node.renamed", (event) => scheduleRealtimeRefresh("node.renamed", event.payload));
  useWorkspaceBroadcast("node.deleted", (event) => scheduleRealtimeRefresh("node.deleted", event.payload));
  useWorkspaceBroadcast("backlink.changed", (event) => scheduleRealtimeRefresh("backlink.changed", event.payload));

  useEffect(() => {
    if (!blockId || !payload) return;
    const frame = requestAnimationFrame(() => {
      const target = Array.from(
        document.querySelectorAll<HTMLElement>("[data-inspector-block]"),
      ).find((element) => element.dataset.inspectorBlock === blockId);
      target?.scrollIntoView({ block: "start", behavior: "smooth" });
      target?.classList.add("ring-1", "ring-[var(--ink)]");
      if (target) setTimeout(() => target.classList.remove("ring-1", "ring-[var(--ink)]"), 1600);
    });
    return () => cancelAnimationFrame(frame);
  }, [blockId, payload]);

  const patchNode = useCallback(async (patch: Partial<KnowledgeNode> & { tag_ids?: string[] }) => {
    if (!payload || !payload.permissions.write || saving) return;
    const previous = payload;
    const { tag_ids: tagIds, ...nodePatch } = patch;
    const optimisticNode = {
      ...payload.node,
      ...nodePatch,
      ...(tagIds
        ? { tags: tags.filter((tag) => tagIds.includes(tag.id)) }
        : {}),
    } as KnowledgeNode;
    setPayload({ ...payload, node: optimisticNode });
    setSaving(true);
    setConflict(false);
    try {
      const response = await fetch(`/api/nodes/${encodeURIComponent(payload.node.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace: workspaceApiRef(address),
          // The overlay may be fresher than the payload: the editor, the
          // subtasks and the goal panel fold their confirmed writes there.
          if_updated_at: newestUpdatedAt(
            payload.node.updated_at,
            nodes.find((candidate) => candidate.id === payload.node.id)?.updated_at,
          ),
          ...patch,
        }),
      });
      if (response.status === 409) {
        setConflict(true);
        await load(true);
        return;
      }
      if (response.status === 401 || response.status === 403) {
        setPayload({ ...previous, permissions: { ...previous.permissions, write: false } });
        toast.error("You no longer have permission to edit this node.");
        return;
      }
      if (!response.ok) throw new Error("update failed");
      const body = (await response.json()) as { node: KnowledgeNode };
      setPayload((current) => current ? { ...current, node: body.node } : current);
      setTitle(body.node.title);
      // Converge the rest of THIS client (board, lists) without a refetch,
      // and ship the same summary to peers so their contexts patch too —
      // a bare nodeId broadcast is skipped by WorkspaceProvider's handler.
      const summary: Partial<KnowledgeNode> = {
        status: body.node.status,
        priority: body.node.priority,
        due_date: body.node.due_date,
        parent_id: body.node.parent_id,
        data: body.node.data,
        tags: body.node.tags,
        title: body.node.title,
        updated_at: body.node.updated_at,
      };
      patchNodeSummary(body.node.id, summary);
      realtime.broadcast("node.updated", { nodeId: body.node.id, summary });
    } catch {
      setPayload(previous);
      setTitle(previous.node.title);
      toast.error("Couldn’t update the node.");
    } finally {
      setSaving(false);
    }
  }, [payload, address, saving, load, patchNodeSummary, realtime, toast, tags, nodes]);

  /**
   * A body wrote on its own (the editor saved, a subtask flipped, a key
   * result changed) and hands back the server's node: keep the panel's
   * copy current — `updated_at` above all, or the next guarded patch would
   * read as a conflict with the person's own edit — and ship the summary
   * to this client's boards and to peers, recount included, so a subtask
   * chip never lags a refetch.
   */
  const onWritten = useCallback((written: KnowledgeNode) => {
    setPayload((current) => (current ? { ...current, node: written } : current));
    setTitle(written.title);
    const summary: Partial<KnowledgeNode> & { subtasks: ReturnType<typeof nodeSubtaskProgress> } = {
      title: written.title,
      status: written.status,
      priority: written.priority,
      due_date: written.due_date,
      data: written.data,
      updated_at: written.updated_at,
      subtasks: nodeSubtaskProgress({ data: written.data }),
    };
    patchNodeSummary(written.id, summary);
    realtime.broadcast("node.updated", { nodeId: written.id, summary });
  }, [patchNodeSummary, realtime]);
  const onConflict = useCallback(() => {
    setConflict(true);
    void load(true);
  }, [load]);

  // Inherited (effective-minus-direct) tags: ancestors of the direct tags
  // through the `parent` hierarchy. Display-only — never written to the node.
  const directTags = payload?.node.tags;
  const inheritedTags = useMemo(() => {
    if (!directTags || directTags.length === 0 || tagRelations.length === 0) return [];
    const tagsById = new Map(tags.map((tag) => [tag.id, tag]));
    const directIds = new Set(directTags.map((tag) => tag.id));
    const viaByAncestor = new Map<string, string[]>();
    for (const direct of directTags) {
      for (const ancestorId of ancestorsOfTags([direct.id], tagRelations)) {
        if (directIds.has(ancestorId)) continue;
        const via = viaByAncestor.get(ancestorId) ?? [];
        if (!via.includes(direct.name)) via.push(direct.name);
        viaByAncestor.set(ancestorId, via);
      }
    }
    return [...viaByAncestor.entries()]
      .flatMap(([ancestorId, via]) => {
        const tag = tagsById.get(ancestorId);
        return tag ? [{ tag, via }] : [];
      })
      .sort((a, b) => a.tag.name.localeCompare(b.tag.name));
  }, [directTags, tags, tagRelations]);

  if (loading && !payload) return <InspectorLoading onClose={onClose} />;
  if (error && !payload) {
    return <InspectorErrorState error={error} onRetry={() => void load(false)} onClose={onClose} />;
  }
  if (!payload) return <InspectorLoading onClose={onClose} />;

  const node = payload.node;
  const canWrite = payload.permissions.write;
  const unavailableParents = descendantIds(nodes, node.id);
  const parentOptions = nodes
    .filter((candidate) => !unavailableParents.has(candidate.id))
    .sort((a, b) => a.title.localeCompare(b.title));
  // `return_to` is set by `openNodePage` when a page was opened from a view;
  // inside the panel it is normally absent.
  const returnTo = typeof window === "undefined"
    ? null
    : new URLSearchParams(window.location.search).get("return_to");

  const connections = buildConnections(payload);
  const plan = panelPlanFor(node.kind);
  // The strip offers what the plan says; a node that already carries a
  // value it would not be offered (a doc an agent gave a status) still shows
  // it, so the value can be read and cleared.
  const showStatus = plan.status !== null || node.status !== null;
  const showPriority = plan.priority || node.priority !== null;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="node-inspector">
      <header className="flex min-h-12 items-center gap-2 border-b border-[var(--line)] px-3 py-2">
        <Chip
          size="sm"
          variant="soft"
          className="mono rounded bg-[var(--paper-3)] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-[var(--ink-3)]"
        >
          <Chip.Label>{node.kind}</Chip.Label>
        </Chip>
        <span className="mono truncate text-[10px] text-[var(--ink-mute)]">{node.id.slice(0, 8)}</span>
        <PresenceAvatars pageId={node.id} />
        {refreshing ? <Loader2 size={11} className="ml-auto animate-spin text-[var(--ink-3)]" /> : <span className="ml-auto" />}
        <Tooltip delay={400}>
          <Button isIconOnly variant="ghost" onPress={() => void load(true)} aria-label="Refresh" className="icon-btn">
            <RefreshCw size={12} />
          </Button>
          <Tooltip.Content>Refresh</Tooltip.Content>
        </Tooltip>
        {toolbar}
      </header>

      {/* Identity strip: the title, the two properties that matter at a
          glance, and two doors — Tags and Details — for everything else.
          The content below is the point of the panel. */}
      <div className="border-b border-[var(--line)] px-5 pb-3 pt-4">
        {returnTo ? (
          <a href={returnTo} className="mb-2 inline-flex items-center gap-1 text-[11px] text-[var(--ink-3)] hover:text-[var(--ink)]">
            <ArrowLeft size={11} /> Back to view
          </a>
        ) : null}
        {!canWrite ? (
          <div className="mb-2 flex items-center gap-2 text-[11px] text-[var(--ink-3)]">
            <LockKeyhole size={12} /> Read-only access
          </div>
        ) : null}
        {conflict ? (
          <div role="alert" className="mb-2 rounded-md border border-[var(--warn)] px-3 py-2 text-[11px] text-[var(--ink)]">
            This node changed elsewhere. The current version was reloaded; review it before retrying.
          </div>
        ) : null}
        <input
          value={title}
          readOnly={!canWrite}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => {
            const next = title.trim();
            if (next && next !== node.title) void patchNode({ title: next });
            else setTitle(node.title);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") { setTitle(node.title); event.currentTarget.blur(); }
          }}
          aria-label="Node title"
          className="-mx-1 w-[calc(100%+8px)] rounded-md border border-transparent bg-transparent px-1 py-0.5 text-[21px] font-semibold leading-tight tracking-[-0.01em] outline-none hover:border-[var(--line)] focus:border-[var(--line-strong)] read-only:border-transparent"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {showStatus ? (
            <PropertySelect
              label="Status"
              value={node.status ?? ""}
              disabled={!canWrite || saving}
              options={[
                { value: "", label: "None" },
                ...statusesFor(node.kind).map((value) => ({ value, label: statusLabel(value) })),
              ]}
              dots={STATUS_DOT}
              onChange={(value) => void patchNode({ status: value ? asNodeStatus(value) : null })}
            />
          ) : null}
          {showPriority ? (
            <PropertySelect
              label="Priority"
              value={node.priority ?? ""}
              disabled={!canWrite || saving}
              options={[{ value: "", label: "None" }, ...PRIORITIES.map((value) => ({ value, label: value }))]}
              dots={PRIORITY_DOT}
              onChange={(value) => void patchNode({ priority: (value || null) as Priority | null })}
            />
          ) : null}
          <span className="ml-auto" />
          <Popover>
            <Button size="sm" variant="ghost" className="gap-1.5 text-[11.5px] text-[var(--ink-2)]" aria-label={`Tags, ${node.tags.length}`}>
              <Tag size={12} />
              Tags
              {node.tags.length > 0 ? <span className="mono text-[10px] text-[var(--ink-mute)]">{node.tags.length}</span> : null}
            </Button>
            <Popover.Content placement="bottom end" className="w-[320px]">
              <Popover.Dialog className="p-3">
                <Popover.Heading className="mono text-[10px] uppercase tracking-[0.08em] text-[var(--ink-mute)]">Tags</Popover.Heading>
                <div className="mt-2 flex flex-wrap gap-1">
                  {node.tags.length === 0 ? <span className="text-[12px] text-[var(--ink-3)]">No tags yet.</span> : null}
                  {node.tags.map((tag) => (
                    <Chip key={tag.id} size="sm" variant="soft" className="gap-1 pr-1">
                      <Hash size={9} className="opacity-60" />
                      <Chip.Label>{tag.name}</Chip.Label>
                      {canWrite ? (
                        <button
                          type="button"
                          aria-label={`Remove ${tag.name}`}
                          disabled={saving}
                          onClick={() => void patchNode({ tag_ids: node.tags.filter((item) => item.id !== tag.id).map((item) => item.id) })}
                          className="rounded-full p-0.5 opacity-50 hover:bg-[var(--paper-3)] hover:opacity-100"
                        >
                          <X size={9} />
                        </button>
                      ) : null}
                    </Chip>
                  ))}
                </div>
                {inheritedTags.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {inheritedTags.map(({ tag, via }) => (
                      <Chip key={tag.id} size="sm" variant="tertiary" title={`Inherited via ${via.join(", ")}`} className="gap-1 text-[10px] text-[var(--ink-mute)]">
                        <Hash size={9} className="opacity-50" />
                        <Chip.Label>{tag.name} <span className="opacity-60">via {via.join(", ")}</span></Chip.Label>
                      </Chip>
                    ))}
                  </div>
                ) : null}
                {canWrite ? (
                  <div className="mt-3">
                    <Button size="sm" variant="outline" isDisabled={saving} onPress={() => setTagsOpen((open) => !open)} aria-expanded={tagsOpen} className="gap-1.5">
                      <Tag size={11} /> Add tag
                    </Button>
                    {tagsOpen ? (
                      <ScrollShadow className="mt-2 max-h-44 rounded-md border border-[var(--line)] bg-[var(--paper)] p-1">
                        {tags.filter((tag) => !node.tags.some((selected) => selected.id === tag.id)).map((tag) => (
                          <Button
                            variant="ghost"
                            key={tag.id}
                            onPress={() => { setTagsOpen(false); void patchNode({ tag_ids: [...node.tags.map((item) => item.id), tag.id] }); }}
                            className="flex w-full items-center justify-start gap-2 rounded px-2 py-1.5 text-left text-[11px] hover:bg-[var(--paper-2)]"
                          >
                            <Hash size={9} /> {tag.name}
                          </Button>
                        ))}
                      </ScrollShadow>
                    ) : null}
                  </div>
                ) : null}
              </Popover.Dialog>
            </Popover.Content>
          </Popover>
          <Button
            size="sm"
            variant={detailsOpen ? "secondary" : "ghost"}
            onPress={() => setDetailsOpen((open) => !open)}
            aria-expanded={detailsOpen}
            className="gap-1.5 text-[11.5px] text-[var(--ink-2)]"
          >
            <Info size={12} />
            Details
            {connections.length > 0 ? <span className="mono text-[10px] text-[var(--ink-mute)]">{connections.length}</span> : null}
          </Button>
          {canWrite ? (
            <CardActionsMenu
              ariaLabel="Node actions"
              isDisabled={saving}
              actions={nodeActionsFor(node)}
              onAction={(key) => {
                if (key === "archive") void archiveNode(node).then((ok) => { if (ok) onClose(); });
                if (key === "delete") requestDelete(node);
              }}
            />
          ) : null}
        </div>
      </div>
      {deleteDialog}

      <ScrollShadow className="scroll min-h-0 flex-1 px-5 py-4">
        {detailsOpen ? (
          <Surface variant="secondary" className="mb-5 rounded-lg p-3">
            {/* One list of everything this node is connected to — backlinks,
                typed relations, dependencies — each row opens the other node
                in this panel. Empty states are one line, not five. */}
            <div className="mono flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.08em] text-[var(--ink-mute)]">
              <span>Connections</span>
              {connections.length > 0 ? <span className="text-[var(--ink-3)]">{connections.length}</span> : null}
            </div>
            <ConnectionsList connections={connections} onOpen={(id, targetBlock) => selectNode(id, { blockId: targetBlock })} />

            <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-[var(--line)] pt-3">
              <span className="mono text-[10px] text-[var(--ink-mute)]" title={payload.freshness.updated_at}>
                Updated {formatRelative(payload.freshness.updated_at)}{payload.freshness.state !== "fresh" ? ` · ${payload.freshness.state}` : ""}
              </span>
              {payload.provenance.map((item) => (
                <span key={item.label} className="mono text-[10px] text-[var(--ink-mute)]">{item.label} {item.value}</span>
              ))}
              <span className="ml-auto" />
              <PropertySelect
                label="Parent"
                value={node.parent_id ?? ""}
                disabled={!canWrite || saving}
                options={[{ value: "", label: "Workspace root" }, ...parentOptions.map((parent) => ({ value: parent.id, label: parent.title }))]}
                onChange={(value) => void patchNode({ parent_id: value || null })}
                className="w-[min(100%,280px)]"
              />
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onPress={() => {
                  const ref = `/n/${node.id}${blockId ? `#${blockId}` : ""}`;
                  void navigator.clipboard.writeText(ref);
                  toast.info("Node reference copied.");
                }}
                className="gap-1.5 text-[11.5px]"
              >
                <Copy size={11} /> Copy reference
              </Button>
              {canWrite ? (
                <Button size="sm" variant="ghost" isDisabled={saving} onPress={() => void duplicateNode(node.id)} className="gap-1.5 text-[11.5px]">
                  <Copy size={11} /> Duplicate
                </Button>
              ) : null}
              {canWrite ? (
                <Button
                  size="sm"
                  variant="ghost"
                  isDisabled={saving}
                  onPress={() => requestDelete(node)}
                  className="ml-auto gap-1.5 text-[11.5px] text-danger"
                >
                  <Trash2 size={11} /> Delete
                </Button>
              ) : null}
            </div>
          </Surface>
        ) : null}
        <div className="pb-6">
          <PanelBodyForKind
            payload={payload}
            workspace={address}
            canWrite={canWrite}
            blockId={blockId}
            openNode={(id, targetBlock) => selectNode(id, { blockId: targetBlock })}
            onWritten={onWritten}
            onConflict={onConflict}
            patchNode={patchNode}
            saving={saving}
          />
        </div>
      </ScrollShadow>
    </div>
  );
}

function InspectorLoading({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 items-center border-b border-[var(--line)] px-3">
        <span className="mono text-[10px] text-[var(--ink-3)]">Loading node…</span>
        <Button isIconOnly variant="ghost" onPress={onClose} className="icon-btn ml-auto" aria-label="Close inspector">
          <X size={13} />
        </Button>
      </header>
      <DetailSkeleton />
    </div>
  );
}

function InspectorErrorState({ error, onRetry, onClose }: { error: InspectorError; onRetry: () => void; onClose: () => void }) {
  const forbidden = error === "forbidden";
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 items-center border-b border-[var(--line)] px-3">
        <span className="mono text-[10px] text-[var(--ink-3)]">Inspector unavailable</span>
        <Button isIconOnly variant="ghost" onPress={onClose} className="icon-btn ml-auto" aria-label="Close inspector">
          <X size={13} />
        </Button>
      </header>
      <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
        {forbidden ? <LockKeyhole size={20} /> : <AlertTriangle size={20} />}
        <p className="mt-3 text-[13px] font-medium">{forbidden ? "You don’t have permission to view this node." : error === "missing" ? "This node no longer exists." : "The inspector couldn’t load."}</p>
        {error === "network" ? <Button variant="ghost" onPress={onRetry} className="mt-3"><RefreshCw size={10} /> Retry</Button> : null}
      </div>
    </div>
  );
}
