"use client";

/**
 * Tag assignment on the `/n/<id>` node page: the node's tags as removable
 * pills and an "Add tag" search over the workspace's existing tags
 * (`GET /api/tags`). It only assigns — creating a tag is an owner/admin act
 * in Settings → Tags, so the empty state points there.
 *
 * Writes are `PUT /api/nodes/:id/tags` with the full id list, optimistic and
 * reverted to the last server-confirmed list on failure; `router.refresh()`
 * afterwards so the server-rendered page agrees.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Hash, Loader2, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button, ComboBox, Input, ListBox, Tag, TagGroup } from "@heroui/react";
import type { KnowledgeNode, WorkspaceTag } from "@bcontext-dev/contract/types";
import { normalizeTagName } from "@bcontext-dev/contract/tags";
import { useToast } from "./workspace-context";
import { workspaceApiRef, type WorkspaceAddress } from "@/web/workspace-url";
import { tagColorCss } from "@/lib/tag-color";

interface TagWithUsage extends WorkspaceTag {
  usage_count?: number;
}
export function TagPicker({
  node,
  workspace,
}: {
  node: KnowledgeNode;
  workspace: WorkspaceAddress;
}) {
  const router = useRouter();
  const toast = useToast();
  const rootRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState<TagWithUsage[]>(node.tags);
  const [selected, setSelected] = useState<WorkspaceTag[]>(node.tags);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  // Last server-confirmed tag list. Reverts restore this snapshot (not a
  // possibly-stale local var) so two rapid add/remove ops can't clobber
  // each other's result when one of them fails.
  const canonicalRef = useRef<WorkspaceTag[]>(node.tags);

  useEffect(() => {
    canonicalRef.current = node.tags;
    setSelected(node.tags);
  }, [node.tags]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/tags?workspace=${encodeURIComponent(workspaceApiRef(workspace))}`, {
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("could not load tags");
        return response.json() as Promise<{ tags: TagWithUsage[] }>;
      })
      .then((data) => {
        if (!cancelled) setAvailable(data.tags);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspace]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const selectedIds = useMemo(
    () => new Set(selected.map((tag) => tag.id)),
    [selected],
  );
  const suggestions = useMemo(() => {
    const needle = normalizeTagName(query);
    return available
      .filter((tag) => !selectedIds.has(tag.id))
      .filter(
        (tag) =>
          !needle ||
          tag.normalized_name.includes(needle) ||
          tag.slug.includes(needle),
      )
      .slice(0, 12);
  }, [available, query, selectedIds]);

  async function persist(next: WorkspaceTag[]) {
    // Optimistic: reflect the tag change instantly, persist in the
    // background, revert to the last known-good (canonical) list on failure.
    setPending(true);
    setSelected(next);
    try {
      const response = await fetch(`/api/nodes/${encodeURIComponent(node.id)}/tags`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace: workspaceApiRef(workspace),
          tag_ids: next.map((tag) => tag.id),
        }),
      });
      if (!response.ok) throw new Error("tag assignment failed");
      canonicalRef.current = next;
      router.refresh();
    } catch {
      setSelected(canonicalRef.current);
      toast.error("Couldn’t update tags.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div ref={rootRef} className="relative mt-3 flex flex-wrap items-center gap-1.5">
      <span aria-hidden className="mono mr-0.5 text-[9px] uppercase tracking-widest text-[var(--ink-mute)]">
        Tags
      </span>
      <TagGroup
        aria-label="Selected tags"
        selectionMode="none"
        size="sm"
        onRemove={(keys) => void persist(selected.filter((tag) => !keys.has(tag.id)))}
      >
        <TagGroup.List className="flex flex-wrap items-center gap-1.5" items={selected}>
          {(tag) => (
            <Tag key={tag.id} id={tag.id} textValue={tag.name}>
              <Hash size={9} style={{ color: tagColorCss(tag.id) }} /> {tag.name}
            </Tag>
          )}
        </TagGroup.List>
      </TagGroup>
      <Button
        className="h-6 gap-1 rounded-md border border-dashed border-[var(--line)] px-2 text-[10.5px] text-[var(--ink-3)] hover:border-[var(--line-strong)] hover:text-[var(--ink)]"
        size="sm"
        variant="ghost"
        onPress={() => setOpen((value) => !value)}
      >
        {pending ? <Loader2 size={10} className="animate-spin" /> : <Plus size={10} />}
        Add tag
      </Button>
      {open && (
        <ComboBox
          className="absolute left-0 top-8 z-30 w-[260px]"
          defaultFilter={() => true}
          inputValue={query}
          menuTrigger="focus"
          onInputChange={setQuery}
          onSelectionChange={(key) => {
            const tag = suggestions.find((candidate) => candidate.id === key);
            if (!tag) return;
            setOpen(false);
            setQuery("");
            void persist([...selected, tag]);
          }}
        >
          <ComboBox.InputGroup className="rounded-lg border border-[var(--line)] bg-[var(--paper)] p-2 shadow-[0_14px_45px_rgba(0,0,0,0.22)]">
            <Input
              autoFocus
              aria-label="Search workspace tags"
              className="h-8 w-full rounded-md border border-[var(--line)] bg-[var(--paper-2)] px-2 text-[12px] outline-none focus:border-[var(--line-strong)]"
              placeholder="Search workspace tags…"
            />
          </ComboBox.InputGroup>
          <ComboBox.Popover className="mt-1 max-h-52 w-[260px] overflow-y-auto rounded-lg border border-[var(--line)] bg-[var(--paper)] p-2 shadow-[0_14px_45px_rgba(0,0,0,0.22)]">
            <ListBox
              renderEmptyState={() => (
                <p className="px-2 py-3 text-[11px] text-[var(--ink-3)]">
                  No matching reusable tag. Workspace admins can create one in Settings → Tags.
                </p>
              )}
            >
              {suggestions.map((tag) => (
                <ListBox.Item
                  key={tag.id}
                  className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[12px] hover:bg-[var(--paper-2)]"
                  id={tag.id}
                  textValue={tag.name}
                >
                  <span className="flex min-w-0 items-center gap-1.5 truncate">
                    <Hash size={10} style={{ color: tagColorCss(tag.id) }} /> {tag.name}
                  </span>
                  <span className="mono text-[9px] text-[var(--ink-mute)]">
                    {tag.usage_count ?? 0}
                  </span>
                </ListBox.Item>
              ))}
            </ListBox>
          </ComboBox.Popover>
        </ComboBox>
      )}
    </div>
  );
}
