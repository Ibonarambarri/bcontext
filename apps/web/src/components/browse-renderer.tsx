"use client";

/**
 * BrowseRenderer — a grid explorer over the workspace's TAG hierarchy, not
 * `parent_id`. Classification, not a flat dump: level 0 shows the workspace's
 * root tags (tags with no parent), entering a tag T shows T's direct child
 * tags first, then the nodes DIRECTLY tagged with T — never all ~300
 * workspace nodes at once, and never a descendant-tag's nodes leaking up
 * (server-side tag filters inherit downward; this walks each node's own
 * direct `tags` array instead, see `src/lib/browse-tags.ts`).
 *
 * Tag data (`tags` + `relations`) is fetched once from `GET /api/tags` (the
 * same endpoint `graph-view.tsx` and `node-inspector.tsx` use) and every
 * level is derived from it in memory — no per-level round-trip for the tag
 * side. Node data comes from `useWorkspace().nodes` (already resolved for
 * this view's scope) and is filtered client-side by direct tag membership,
 * which is exact and needs no extra query. Only the per-card content summary
 * is fetched lazily, one request per node card visible at the current level
 * (`GET /api/nodes/:id/inspector?scope=preview`), cached by id for the life
 * of the module. Browse never opens a hover popup; the card itself carries
 * the summary.
 *
 * Mounted by `view-canvas.tsx` for `browse`-renderer saved views.
 *
 * Nodes with zero tags can't be reached by walking the tag tree at all, so
 * level 0 gets a synthetic "Untagged" folder card (only when such nodes
 * exist) that lists them directly.
 */

import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Folder, FolderTree, Hash } from "lucide-react";
import { Button, Chip, ScrollShadow } from "@heroui/react";
import { EmptyState } from "@/components/ui/empty-state";
import { statusLabel, type KnowledgeNode, type TagRelation, type WorkspaceTag } from "@bcontext-dev/contract/types";
import { cn } from "@bcontext-dev/contract/utils";
import type { SavedView } from "@bcontext-dev/contract/views/types";
import { nodeKindIcon } from "./node-kind-icon";
import type { NodeInspectorPayload } from "@bcontext-dev/contract/node-inspector";
import { ViewSkeleton } from "@/components/skeletons";
import { useWorkspace } from "./workspace-context";
import {
  childTagsOf,
  nodesDirectlyTagged,
  rootTags,
  sortNodes,
  sortTags,
  untaggedNodes,
  type TagWithUsage,
} from "@/lib/browse-tags";
import { workspaceApiRef, type WorkspaceAddress } from "@/web/workspace-url";

const UNTAGGED_KEY = "__untagged__";

interface TagsResponse {
  tags?: TagWithUsage[];
  relations?: Pick<TagRelation, "id" | "from_tag_id" | "to_tag_id" | "relation">[];
}

/** Module-level cache — re-showing the same node card across drill-in/out
 * within the session skips the network round-trip entirely. */
const summaryCache = new Map<string, string | null>();

function summarizeContentMd(md: string): string | null {
  if (!md) return null;
  // Strip a leading YAML frontmatter block so the card snippet doesn't read
  // "--- title: … ---" for nodes that start with frontmatter.
  const body = md.replace(/^﻿?\s*---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const lines = body
    .split("\n")
    .map((line) =>
      line
        .replace(/^#{1,6}\s*/, "")
        .replace(/^[-*+]\s+\[[ xX]\]\s*/, "")
        .replace(/^[-*+]\s+/, "")
        .replace(/^>\s?/, "")
        .replace(/[*_`]/g, "")
        .trim(),
    )
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  const summary = lines.slice(0, 2).join(" ");
  return summary.length > 160 ? `${summary.slice(0, 157)}…` : summary;
}

async function fetchNodeSummary(nodeId: string, workspace: WorkspaceAddress): Promise<string | null> {
  if (summaryCache.has(nodeId)) return summaryCache.get(nodeId) ?? null;
  const response = await fetch(
    `/api/nodes/${encodeURIComponent(nodeId)}/inspector?workspace=${encodeURIComponent(workspaceApiRef(workspace))}&scope=preview`,
    { cache: "no-store" },
  );
  if (!response.ok) throw new Error("preview fetch failed");
  const payload = (await response.json()) as NodeInspectorPayload;
  const summary = summarizeContentMd(payload.node.content_md);
  summaryCache.set(nodeId, summary);
  return summary;
}

/** One segment of the tag-path breadcrumb. */
interface Crumb {
  key: string | null;
  title: string;
}

export function BrowseRenderer({ view }: { view: SavedView }) {
  const { address, nodes, inspectedNodeId, selectNode } = useWorkspace();
  const [tagsPayload, setTagsPayload] = useState<TagsResponse | null>(null);
  const [tagsError, setTagsError] = useState<string | null>(null);
  const [path, setPath] = useState<TagWithUsage[]>([]);

  useEffect(() => {
    let cancelled = false;
    setTagsPayload(null);
    setTagsError(null);
    fetch(`/api/tags?workspace=${encodeURIComponent(workspaceApiRef(address))}`, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("tags fetch failed");
        return response.json() as Promise<TagsResponse>;
      })
      .then((data) => {
        if (!cancelled) setTagsPayload(data);
      })
      .catch(() => {
        if (!cancelled) setTagsError("Couldn't load tags.");
      });
    return () => {
      cancelled = true;
    };
  }, [address]);

  const tags = useMemo(() => tagsPayload?.tags ?? [], [tagsPayload]);
  const relations = useMemo(() => tagsPayload?.relations ?? [], [tagsPayload]);

  // A tag drilled into can disappear between re-fetches (deleted/merged) —
  // fall back to the deepest still-valid ancestor rather than a dead level.
  const tagsById = useMemo(() => new Map(tags.map((tag) => [tag.id, tag])), [tags]);
  const validPath = useMemo(() => {
    const cut = path.findIndex((tag) => !tagsById.has(tag.id));
    return cut === -1 ? path : path.slice(0, cut);
  }, [path, tagsById]);

  const currentTag = validPath[validPath.length - 1] ?? null;
  const atRoot = validPath.length === 0;

  const [viewingUntagged, setViewingUntagged] = useState(false);

  const childTags = useMemo(() => {
    if (viewingUntagged) return [];
    if (!currentTag) return sortTags(rootTags(tags, relations));
    return sortTags(childTagsOf(currentTag.id, tags, relations));
  }, [viewingUntagged, currentTag, tags, relations]);

  const directNodes = useMemo(() => {
    if (viewingUntagged) return sortNodes(untaggedNodes(nodes));
    if (!currentTag) return [];
    return sortNodes(nodesDirectlyTagged(nodes, currentTag.id));
  }, [viewingUntagged, currentTag, nodes]);

  const showUntaggedFolder = atRoot && !viewingUntagged && untaggedNodes(nodes).length > 0;

  const crumbs: Crumb[] = [
    { key: null, title: view.name },
    ...validPath.map((tag) => ({ key: tag.id, title: tag.name })),
    ...(viewingUntagged ? [{ key: UNTAGGED_KEY, title: "Untagged" }] : []),
  ];

  const drillIntoTag = (tag: TagWithUsage) => {
    setViewingUntagged(false);
    setPath([...validPath, tag]);
  };

  const drillIntoUntagged = () => {
    setViewingUntagged(true);
  };

  const goToCrumb = (index: number) => {
    if (index === crumbs.length - 1) return;
    if (index === 0) {
      setViewingUntagged(false);
      setPath([]);
      return;
    }
    setViewingUntagged(false);
    setPath(validPath.slice(0, index));
  };

  const isEmpty = childTags.length === 0 && directNodes.length === 0 && !showUntaggedFolder;

  if (!tagsPayload && !tagsError) return <ViewSkeleton />;

  return (
    <ScrollShadow className="scroll h-full overflow-y-auto" role="region" aria-label={view.name}>
      <div className="w-full px-4 pb-16 pt-4 sm:px-8 sm:pt-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="m-0 text-[12px] text-[var(--ink-3)]">
            {childTags.length} {childTags.length === 1 ? "tag" : "tags"} · {directNodes.length}{" "}
            {directNodes.length === 1 ? "node" : "nodes"}
          </p>
        </div>

        <nav aria-label="Breadcrumb" className="mb-2 flex flex-wrap items-center gap-1">
          {crumbs.map((crumb, idx) =>
            idx === crumbs.length - 1 ? (
              <span
                key={crumb.key ?? "root"}
                className="max-w-[280px] truncate px-1.5 py-0.5 text-[12px] font-medium text-[var(--ink)]"
              >
                {crumb.title}
              </span>
            ) : (
              <span key={crumb.key ?? "root"} className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-auto min-h-0 max-w-[200px] truncate px-1.5 py-0.5 text-[12px] text-[var(--ink-3)]"
                  onPress={() => goToCrumb(idx)}
                >
                  {crumb.title}
                </Button>
                <ChevronRight size={12} className="shrink-0 text-[var(--ink-mute)]" aria-hidden />
              </span>
            ),
          )}
        </nav>

        {tagsError ? (
          <EmptyState className="mt-4 min-h-[240px] rounded-2xl border border-dashed border-[var(--line)] bg-[var(--paper-2)] px-6 py-10">
            <EmptyState.Header>
              <EmptyState.Media variant="icon">
                <FolderTree size={20} />
              </EmptyState.Media>
              <EmptyState.Title className="text-[16px] text-[var(--ink)]">{tagsError}</EmptyState.Title>
            </EmptyState.Header>
          </EmptyState>
        ) : isEmpty ? (
          <EmptyState className="mt-4 min-h-[320px] rounded-2xl border border-dashed border-[var(--line)] bg-[var(--paper-2)] px-6 py-12">
            <EmptyState.Header>
              <EmptyState.Media variant="icon">
                <FolderTree size={20} />
              </EmptyState.Media>
              <EmptyState.Title className="text-[16px] text-[var(--ink)]">Nothing here yet</EmptyState.Title>
              <EmptyState.Description className="max-w-[430px]">
                {viewingUntagged
                  ? "No untagged nodes."
                  : currentTag
                    ? `#${currentTag.name} has no sub-tags and no nodes tagged directly with it.`
                    : "No tags or untagged nodes to browse yet."}
              </EmptyState.Description>
            </EmptyState.Header>
          </EmptyState>
        ) : (
          <div
            role="listbox"
            aria-label={view.name}
            className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3"
          >
            {showUntaggedFolder ? (
              <TagFolderCard
                key={UNTAGGED_KEY}
                title="Untagged"
                childCount={0}
                nodeCount={untaggedNodes(nodes).length}
                onActivate={drillIntoUntagged}
              />
            ) : null}
            {childTags.map((tag) => (
              <TagFolderCard
                key={tag.id}
                title={tag.name}
                childCount={childTagsOf(tag.id, tags, relations).length}
                nodeCount={tag.usage_count}
                onActivate={() => drillIntoTag(tag)}
              />
            ))}
            {directNodes.map((node) => (
              <NodeCard
                key={node.id}
                node={node}
                workspace={address}
                isInspected={inspectedNodeId === node.id}
                onActivate={() => selectNode(node.id)}
              />
            ))}
          </div>
        )}
      </div>
    </ScrollShadow>
  );
}

function activateOnKey(event: React.KeyboardEvent, onActivate: () => void) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    onActivate();
  }
}

function TagFolderCard({
  title,
  childCount,
  nodeCount,
  onActivate,
}: {
  title: string;
  childCount: number;
  nodeCount: number;
  onActivate: () => void;
}) {
  const countLine =
    childCount > 0
      ? `${childCount} ${childCount === 1 ? "tag" : "tags"} · ${nodeCount} ${nodeCount === 1 ? "node" : "nodes"}`
      : `${nodeCount} ${nodeCount === 1 ? "node" : "nodes"}`;

  return (
    <div
      role="option"
      aria-selected={false}
      tabIndex={0}
      onClick={onActivate}
      onKeyDown={(event) => activateOnKey(event, onActivate)}
      className={cn(
        "flex min-h-[132px] cursor-pointer flex-col justify-between gap-3 rounded-xl border border-[var(--line)] bg-[var(--paper)] p-4 outline-none transition-colors",
        "hover:bg-[var(--paper-3)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
      )}
    >
      <div className="flex items-center gap-2">
        <Folder size={20} className="shrink-0 text-[var(--ink-3)]" aria-hidden />
        <Hash size={13} className="shrink-0 text-[var(--ink-mute)]" aria-hidden />
      </div>
      <div>
        <p className="m-0 truncate text-[14px] font-medium text-[var(--ink)]">{title}</p>
        <p className="m-0 mt-1 text-[11px] text-[var(--ink-mute)]">{countLine}</p>
      </div>
    </div>
  );
}

function NodeCard({
  node,
  workspace,
  isInspected,
  onActivate,
}: {
  node: KnowledgeNode;
  workspace: WorkspaceAddress;
  isInspected: boolean;
  onActivate: () => void;
}) {
  const Icon = nodeKindIcon(node.kind);
  const [summary, setSummary] = useState<string | null>(() => summaryCache.get(node.id) ?? null);

  useEffect(() => {
    if (summaryCache.has(node.id)) {
      setSummary(summaryCache.get(node.id) ?? null);
      return;
    }
    let cancelled = false;
    fetchNodeSummary(node.id, workspace)
      .then((result) => {
        if (!cancelled) setSummary(result);
      })
      .catch(() => {
        // Best-effort — the card still shows title/tags/status without it.
      });
    return () => {
      cancelled = true;
    };
  }, [node.id, workspace]);

  const tags: WorkspaceTag[] = node.tags ?? [];

  return (
    <div
      role="option"
      aria-selected={isInspected}
      data-node-id={node.id}
      tabIndex={0}
      onClick={onActivate}
      onKeyDown={(event) => activateOnKey(event, onActivate)}
      className={cn(
        "flex min-h-[132px] cursor-pointer flex-col gap-2 rounded-xl border p-4 outline-none transition-colors",
        "border-[var(--line)] bg-[var(--paper)] hover:bg-[var(--paper-3)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
        isInspected && "border-[var(--accent)] bg-[var(--paper-3)]",
      )}
    >
      <div className="flex items-start gap-2">
        <Icon size={17} className="mt-0.5 shrink-0 text-[var(--ink-3)]" aria-hidden />
        <p className="m-0 line-clamp-2 min-w-0 flex-1 text-[13px] font-medium leading-snug text-[var(--ink)]">
          {node.title}
        </p>
      </div>
      <p className="m-0 line-clamp-2 text-[11.5px] leading-snug text-[var(--ink-3)]">
        {summary ?? "No content yet."}
      </p>
      <div className="mt-auto flex flex-wrap items-center gap-1">
        {node.status ? (
          <Chip size="sm" variant="tertiary" className="rounded-full px-1.5 py-0 text-[9px] text-[var(--ink-mute)]">
            <Chip.Label>{statusLabel(node.status)}</Chip.Label>
          </Chip>
        ) : null}
        {tags.slice(0, 3).map((tag) => (
          <Chip key={tag.id} size="sm" variant="tertiary" className="gap-1 rounded-full px-1.5 py-0 text-[9px] text-[var(--ink-mute)]">
            <Hash size={9} /> <Chip.Label>{tag.name}</Chip.Label>
          </Chip>
        ))}
      </div>
    </div>
  );
}
