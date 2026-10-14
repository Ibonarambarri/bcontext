"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Network, Plus, Settings2, Tags } from "lucide-react";
import { Button, CloseButton, Tabs } from "@heroui/react";
import { Sheet } from "@/components/ui/sheet";
import type { GraphResourcePayload, GraphSnapshot } from "@bcontext-dev/contract/graph/model";
import type { SavedView } from "@bcontext-dev/contract/views/types";
import type { ViewQuery } from "@bcontext-dev/contract/views/schema";
import type { TagRelation } from "@bcontext-dev/contract/types";
import { normalizeTagName } from "@bcontext-dev/contract/tags";
import { buildTagFocusSnapshot, type TagWithUsage } from "@/lib/graph/tag-focus";
import { GraphRenderer } from "./graph-renderer";
import { GraphSkeleton } from "./skeletons";
import { AddTagModal, TagHoverCard } from "./tag-graph-controls";
import { TagManager } from "./tag-manager";
import { ViewHeaderSlot } from "./view-header-slot";
import { useWorkspace } from "./workspace-context";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { workspaceApiRef } from "@/web/workspace-url";

/**
 * The Brain surface: every `graph`-renderer saved view, system or custom.
 * Mounted by `view-canvas.tsx`; the snapshot comes resolved from the
 * workspace context (`activeViewGraph`), this file only decides which focus
 * to draw and wires the tag authoring.
 *
 * The system Brain view carries a second focus, "Tags" — the workspace
 * taxonomy drawn from the same live graph, with the tag authoring (add,
 * manage, relations) beside it, because two graph surfaces sharing most of
 * their data is one surface. Custom graph views keep a single focus; their
 * query already decides what they are about.
 */
type GraphFocus = "knowledge" | "tags";

interface TagsResponse {
  tags: TagWithUsage[];
  relations?: TagRelation[];
  can_manage?: boolean;
}

export function GraphView({ view }: { view: SavedView }) {
  const {
    address,
    workspace,
    activeViewResult,
    activeViewGraph,
    inspectedNodeId,
    nodePanelSize,
    selectNode,
    refreshViews,
    toast,
  } = useWorkspace();
  const isMobile = useIsMobile();
  const supportsTagFocus = view.system_key === "graph";
  const [focus, setFocus] = useState<GraphFocus>("knowledge");
  const tagFocus = supportsTagFocus && focus === "tags";

  const [tags, setTags] = useState<TagWithUsage[] | null>(null);
  const [relations, setRelations] = useState<TagRelation[]>([]);
  const [tagsError, setTagsError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [manageFocusTagId, setManageFocusTagId] = useState<string | null>(null);
  // Last server-confirmed lists; a failed optimistic create reverts to these
  // rather than to a possibly-stale local variable.
  const canonicalTagsRef = useRef<TagWithUsage[]>([]);
  const canonicalRelationsRef = useRef<TagRelation[]>([]);

  const loadTags = useCallback(async () => {
    try {
      const response = await fetch(`/api/tags?workspace=${encodeURIComponent(workspaceApiRef(address))}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Couldn’t load tags");
      const data = (await response.json()) as TagsResponse;
      // `relations` is optional in the response shape: a missing list means
      // "no relations known", not a failed focus.
      const nextTags = data.tags ?? [];
      const nextRelations = data.relations ?? [];
      canonicalTagsRef.current = nextTags;
      canonicalRelationsRef.current = nextRelations;
      setTags(nextTags);
      setRelations(nextRelations);
      setTagsError(null);
    } catch {
      setTagsError("Couldn’t load the tag graph.");
    }
  }, [address]);

  // Tags are only fetched once the focus is actually entered — the knowledge
  // focus is the default and must not pay for a request it never reads.
  useEffect(() => {
    if (tagFocus) void loadTags();
  }, [tagFocus, loadTags]);

  const openManage = useCallback((tagId: string | null) => {
    setManageFocusTagId(tagId);
    setManageOpen(true);
  }, []);

  const createTag = useCallback(async (input: { name: string; parentIds: string[]; relatedIds: string[] }) => {
    const normalized = normalizeTagName(input.name);
    if (!normalized) return;
    const canonicalTags = canonicalTagsRef.current;
    const canonicalRelations = canonicalRelationsRef.current;
    const optimisticId = `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = new Date().toISOString();
    const optimisticTag: TagWithUsage = {
      id: optimisticId,
      workspace_id: workspace?.id ?? "",
      name: input.name.trim(),
      normalized_name: normalized,
      slug: normalized.replace(/\s+/g, "-"),
      description: null,
      merged_into_id: null,
      deleted_at: null,
      created_at: now,
      updated_at: now,
      usage_count: 0,
    };
    const optimisticRelations: TagRelation[] = [
      ...input.parentIds.map((parentId): TagRelation => ({
        id: `temp-rel-${optimisticId}-parent-${parentId}`,
        workspace_id: workspace?.id ?? "",
        from_tag_id: optimisticId,
        to_tag_id: parentId,
        relation: "parent",
        created_at: now,
      })),
      ...input.relatedIds.map((relatedId): TagRelation => ({
        id: `temp-rel-${optimisticId}-related-${relatedId}`,
        workspace_id: workspace?.id ?? "",
        from_tag_id: optimisticId,
        to_tag_id: relatedId,
        relation: "related",
        created_at: now,
      })),
    ];

    setTags((current) => [...(current ?? []), optimisticTag]);
    setRelations((current) => [...current, ...optimisticRelations]);
    setAddOpen(false);

    try {
      const response = await fetch("/api/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace: workspaceApiRef(address),
          name: input.name.trim(),
          parent_ids: input.parentIds.length > 0 ? input.parentIds : undefined,
          related_ids: input.relatedIds.length > 0 ? input.relatedIds : undefined,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(body.message ?? "Couldn’t create tag");
      }
      // Reload rather than splice the response in: the server assigns the
      // ids of the tag and its relations, and the list is small.
      await loadTags();
      toast.info("Tag created.");
    } catch (error) {
      setTags(canonicalTags);
      setRelations(canonicalRelations);
      toast.error(error instanceof Error ? error.message : "Couldn’t create tag");
    }
  }, [address, loadTags, toast, workspace?.id]);

  const focusSnapshot = useMemo(() => {
    if (!tagFocus || !activeViewGraph || !workspace || !tags) return null;
    return buildTagFocusSnapshot({ workspace, snapshot: activeViewGraph, tags, relations });
  }, [activeViewGraph, relations, tagFocus, tags, workspace]);
  const snapshot: GraphSnapshot | null = tagFocus ? focusSnapshot : activeViewGraph;

  const switcher = supportsTagFocus ? (
    <ViewHeaderSlot>
      <div className="flex min-w-0 items-center gap-1.5">
        <Tabs selectedKey={focus} onSelectionChange={(key) => setFocus(key as GraphFocus)}>
          <Tabs.ListContainer className="rounded-lg bg-[var(--paper-2)]">
            <Tabs.List aria-label="Graph focus" className="gap-0.5 bg-transparent p-0.5">
              <Tabs.Tab id="knowledge" className="h-6 gap-1.5 px-2 text-[11.5px]">
                <Network size={12} />
                Knowledge
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="tags" className="h-6 gap-1.5 px-2 text-[11.5px]">
                <Tags size={12} />
                Tags
                <Tabs.Indicator />
              </Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
        </Tabs>
        {tagFocus ? (
          <>
            <Button size="sm" variant="outline" className="h-7" onPress={() => openManage(null)}>
              <Settings2 size={12} /> Manage
            </Button>
            <Button size="sm" className="h-7" onPress={() => setAddOpen(true)}>
              <Plus size={12} /> Add tag
            </Button>
          </>
        ) : null}
      </div>
    </ViewHeaderSlot>
  ) : null;

  return (
    <>
      {switcher}
      {tagFocus ? (
        <TagFocusCanvas
          error={tagsError}
          tags={tags}
          relations={relations}
          snapshot={snapshot}
          onRetry={() => void loadTags()}
          onAdd={() => setAddOpen(true)}
          onOpenManage={openManage}
        />
      ) : (
        <KnowledgeFocusCanvas
          view={view}
          snapshot={snapshot}
          filters={activeViewResult ? filterLabels(activeViewResult.applied_filters) : []}
          inspectedNodeId={inspectedNodeId}
          focusAnchorX={inspectedNodeId && !isMobile && nodePanelSize === "half" ? 0.25 : 0.5}
          onSelect={selectNode}
          onSelectTag={(tagId) => {
            setFocus("tags");
            openManage(tagId);
          }}
          onRefreshViews={refreshViews}
          address={address}
          toast={toast}
        />
      )}

      <AddTagModal
        open={addOpen}
        tags={tags ?? []}
        onClose={() => setAddOpen(false)}
        onCreate={(input) => void createTag(input)}
      />

      <Sheet isOpen={manageOpen} placement="right" onOpenChange={setManageOpen}>
        <Sheet.Backdrop variant="blur" className="z-[70]">
          <Sheet.Content className="mx-auto max-h-[92dvh] max-w-[720px]">
            <Sheet.Dialog aria-labelledby="tag-manager-title" className="scroll max-h-[92dvh] overflow-y-auto">
              <Sheet.Header className="flex items-center justify-between border-b border-[var(--line)] px-5 py-4">
                <Sheet.Heading id="tag-manager-title">Manage tags</Sheet.Heading>
                <CloseButton aria-label="Close tag manager" onPress={() => setManageOpen(false)} />
              </Sheet.Header>
              <Sheet.Body className="px-5 py-5">
                <TagManager focusedTagId={manageFocusTagId} />
              </Sheet.Body>
            </Sheet.Dialog>
          </Sheet.Content>
        </Sheet.Backdrop>
      </Sheet>
    </>
  );
}

/** The taxonomy focus: tags as hubs, their nodes hanging off them. */
function TagFocusCanvas({
  error,
  tags,
  relations,
  snapshot,
  onRetry,
  onAdd,
  onOpenManage,
}: {
  error: string | null;
  tags: TagWithUsage[] | null;
  relations: TagRelation[];
  snapshot: GraphSnapshot | null;
  onRetry: () => void;
  onAdd: () => void;
  onOpenManage: (tagId: string) => void;
}) {
  const [hover, setHover] = useState<{ tag: TagWithUsage; x: number; y: number } | null>(null);
  const [hoverOpen, setHoverOpen] = useState(false);
  const hoverTimerRef = useRef<number | null>(null);

  const handleHoverResource = useCallback((event: { resource: GraphResourcePayload; x: number; y: number } | null) => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    const resource = event?.resource;
    const tag = resource?.resource_type === "tag"
      ? (tags ?? []).find((item) => item.id === resource.tag.id) ?? null
      : null;
    setHoverOpen(false);
    if (!event || !tag) {
      setHover(null);
      return;
    }
    setHover({ tag, x: event.x, y: event.y });
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = null;
      setHoverOpen(true);
    }, 400);
  }, [tags]);

  useEffect(() => () => {
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
  }, []);

  if (error) {
    return (
      <CenteredState>
        <p className="text-[12px] text-[var(--ink-3)]">{error}</p>
        <Button size="sm" variant="outline" onPress={onRetry}>Retry</Button>
      </CenteredState>
    );
  }
  if (tags === null || !snapshot) return <GraphSkeleton />;
  if (tags.length === 0) {
    return (
      <CenteredState>
        <p className="text-[13px] font-medium text-foreground">No tags yet</p>
        <p className="max-w-[380px] text-[12px] text-[var(--ink-3)]">
          Tags classify nodes across the workspace. Create the first one to start the graph.
        </p>
        <Button size="sm" onPress={onAdd}><Plus size={12} /> Create the first tag</Button>
      </CenteredState>
    );
  }

  return (
    <div className="relative h-full min-h-0">
      {/* Tags and nothing else — few resources, every label meaningful. */}
      <GraphRenderer
        key="tag-focus"
        title="Tags"
        snapshot={snapshot}
        alwaysShowLabels
        onSelectTag={onOpenManage}
        onHoverResource={handleHoverResource}
      />
      <TagHoverCard hover={hover} open={hoverOpen} tags={tags} relations={relations} onOpenChange={setHoverOpen} />
    </div>
  );
}

/**
 * The default focus: the view's own query.
 *
 * No hover preview here. A dwell popup over a graph node covered the very
 * neighbourhood you were reading, and everything it showed — title, kind,
 * status, tags, an excerpt — is what clicking the node puts in the inspector
 * anyway, without hiding half the canvas. Board and browse dropped the same
 * pattern earlier (see node-reveal.tsx); the graph was the last holdout.
 */
function KnowledgeFocusCanvas({
  view,
  snapshot,
  filters,
  inspectedNodeId,
  focusAnchorX,
  onSelect,
  onSelectTag,
  onRefreshViews,
  address,
  toast,
}: {
  view: SavedView;
  snapshot: GraphSnapshot | null;
  filters: string[];
  inspectedNodeId: string | null;
  focusAnchorX: number;
  onSelect: (nodeId: string) => void;
  onSelectTag: (tagId: string) => void;
  onRefreshViews: () => Promise<void>;
  address: ReturnType<typeof useWorkspace>["address"];
  toast: ReturnType<typeof useWorkspace>["toast"];
}) {
  const persistLayout = useCallback(async (
    graph: Record<string, unknown>,
    failure: string,
    success: string,
  ) => {
    const response = await fetch(`/api/views/${encodeURIComponent(view.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace: workspaceApiRef(address),
        expected_version: view.version,
        presentation: { ...view.presentation, layout: { ...view.presentation.layout, graph } },
      }),
    });
    if (!response.ok) {
      toast.error(response.status === 409 ? "This view changed elsewhere. Reload before trying again." : failure);
      return;
    }
    await onRefreshViews();
    toast.info(success);
  }, [address, onRefreshViews, toast, view.id, view.presentation, view.version]);

  if (!snapshot) return <GraphSkeleton />;

  const graphLayout = graphLayoutConfig(view.presentation.layout);
  const foldedTagIds = Array.isArray(graphLayout.folded_tag_ids)
    ? graphLayout.folded_tag_ids.filter((id): id is string => typeof id === "string")
    : [];
  const editable = view.kind === "custom";
  const positions = graphLayout.positions && typeof graphLayout.positions === "object" && !Array.isArray(graphLayout.positions)
    ? graphLayout.positions as Record<string, unknown>
    : {};

  return (
    <div className="relative h-full min-h-0">
      <GraphRenderer
        key={view.id}
        title={view.name}
        filters={filters}
        snapshot={snapshot}
        selectedNodeId={inspectedNodeId}
        flyToSelection
        focusAnchorX={focusAnchorX}
        onSelect={onSelect}
        onSelectTag={onSelectTag}
        foldedTagIds={foldedTagIds}
        onFoldedTagsChange={editable ? (tagIds) => void persistLayout(
          { ...graphLayout, folded_tag_ids: tagIds },
          "Couldn’t save folded tags.",
          tagIds.length > 0 ? "Tag grouping saved." : "All tags released.",
        ) : undefined}
        onNodePositionChange={editable ? (nodeId, point) => void persistLayout(
          { ...graphLayout, positions: { ...positions, [nodeId]: point } },
          "Couldn’t save graph layout.",
          "Graph layout saved.",
        ) : undefined}
        onResetNodePositions={editable ? () => void persistLayout(
          { ...graphLayout, positions: {} },
          "Couldn’t reset graph layout.",
          "Graph positions released.",
        ) : undefined}
      />
    </div>
  );
}

function CenteredState({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full min-h-[180px] flex-col items-center justify-center gap-2 p-6 text-center">{children}</div>;
}

function graphLayoutConfig(layout: Record<string, unknown>): Record<string, unknown> {
  const graph = layout.graph;
  return graph && typeof graph === "object" && !Array.isArray(graph)
    ? graph as Record<string, unknown>
    : {};
}

function filterLabels(query: ViewQuery): string[] {
  return [
    ...query.kinds.map((value) => `kind:${value}`),
    ...query.statuses.map((value) => `status:${value}`),
    ...query.tags_any.map((value) => `tag:${value}`),
    ...query.tags_all.map((value) => `tag-all:${value}`),
    ...query.source.map((value) => `source:${value}`),
    ...query.actor.map((value) => `actor:${value}`),
    ...query.dates.map((value) => `${value.field}:${value.from ? `from ${value.from.slice(0, 10)}` : ""}${value.from && value.to ? " " : ""}${value.to ? `to ${value.to.slice(0, 10)}` : ""}`),
    ...query.root_node_ids.map(() => "root"),
    ...(query.traversal ? [`depth:${query.traversal.depth}`] : []),
  ];
}
