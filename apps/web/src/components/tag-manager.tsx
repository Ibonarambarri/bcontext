"use client";

/**
 * The workspace taxonomy, editable: list every tag with its usage count,
 * create, rename, merge into another and delete. Mounted twice — Settings →
 * Tags (`settings-dialog.tsx`) and the Brain graph's manage panel
 * (`graph-view.tsx`, which passes `focusedTagId` to scroll one row into
 * view). Reads `GET /api/tags` (which also says `can_manage`: owner/admin);
 * writes through `/api/tags*` and reloads on `graph.changed` broadcasts.
 *
 * Rename and merge are optimistic against a canonical snapshot; delete is
 * destructive and blocks its own button while in flight. Tags classify,
 * never authorize — workspace RLS stays the authority.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Merge, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button, Input, ListBox, Select, TextField } from "@heroui/react";
import type { WorkspaceTag } from "@bcontext-dev/contract/types";
import { normalizeTagName } from "@bcontext-dev/contract/tags";
import { cn } from "@bcontext-dev/contract/utils";
import { ListSkeleton } from "./skeletons";
import { useToast, useWorkspace } from "./workspace-context";
import { TagColorDot } from "./tag-color-dot";
import { useWorkspaceBroadcast } from "@/lib/collab/workspace-realtime";
import { workspaceApiRef, type WorkspaceAddress } from "@/web/workspace-url";

interface ManagedTag extends WorkspaceTag {
  usage_count: number;
}

/** `focusedTagId`: highlight that row and scroll it into view once the list has loaded. */
export function TagManager({ focusedTagId = null }: { focusedTagId?: string | null } = {}) {
  const { address } = useWorkspace();
  const toast = useToast();
  const [tags, setTags] = useState<ManagedTag[] | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  // Last server-confirmed tag list. Reverts restore this snapshot (not a
  // possibly-stale local var) so a failed op can't clobber a newer optimistic
  // change made while it was in flight.
  const canonicalRef = useRef<ManagedTag[]>([]);

  const load = useCallback(async () => {
    const response = await fetch(`/api/tags?workspace=${encodeURIComponent(workspaceApiRef(address))}`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Couldn’t load tags");
    const data = (await response.json()) as { tags: ManagedTag[]; can_manage: boolean };
    canonicalRef.current = data.tags;
    setTags(data.tags);
    setCanManage(data.can_manage);
  }, [address]);

  useEffect(() => {
    void load().catch((error) => toast.error(error.message));
  }, [load, toast]);
  useWorkspaceBroadcast("graph.changed", () => { void load(); });

  useEffect(() => {
    if (!focusedTagId || tags === null) return;
    const frame = requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-tag-id="${CSS.escape(focusedTagId)}"]`)?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusedTagId, tags]);

  const normalized = normalizeTagName(name);
  const duplicate = useMemo(
    () => tags?.find((tag) => tag.normalized_name === normalized) ?? null,
    [normalized, tags],
  );

  const applyOptimistic = useCallback((updater: (current: ManagedTag[]) => ManagedTag[]) => {
    setTags((current) => (current ? updater(current) : current));
  }, []);
  const getCanonical = useCallback(() => canonicalRef.current, []);
  const setCanonical = useCallback((next: ManagedTag[]) => {
    canonicalRef.current = next;
  }, []);

  async function create() {
    if (!normalized || duplicate || !canManage) return;
    // Optimistic: show the new tag immediately with a placeholder id, then
    // reconcile with the server. Revert to the canonical list on failure.
    const canonical = canonicalRef.current;
    const draftName = name.trim();
    const draftDescription = description;
    const optimisticTag: ManagedTag = {
      id: `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      workspace_id: "",
      name: draftName,
      normalized_name: normalized,
      slug: normalized,
      description: draftDescription || null,
      merged_into_id: null,
      deleted_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      usage_count: 0,
    };
    setTags((current) => (current ? [...current, optimisticTag] : current));
    setName("");
    setDescription("");
    try {
      const response = await fetch("/api/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace: workspaceApiRef(address), name: draftName, description: draftDescription }),
      });
      const data = (await response.json()) as { message?: string };
      if (!response.ok) throw new Error(data.message ?? "Couldn’t create tag");
      await load();
      toast.info("Tag created.");
    } catch (error) {
      setTags(canonical);
      setName(draftName);
      setDescription(draftDescription);
      toast.error(error instanceof Error ? error.message : "Couldn’t create tag");
    }
  }

  if (tags === null) {
    return <ListSkeleton rows={4} container="plain" label="Loading tags" />;
  }

  return (
    <div className="space-y-4">
      <p className="text-[12px] leading-relaxed text-[var(--ink-3)]">
        Tags are reusable workspace taxonomy. They classify nodes but never grant access; workspace RLS remains authoritative.
      </p>
      {canManage ? (
        <div className="rounded-md border border-[var(--line)] bg-[var(--paper-2)] p-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_1.5fr_auto]">
            <div>
              <TextField aria-label="Tag name" value={name} onChange={setName}>
                <Input
                  autoComplete="off"
                  className="h-8 w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-2.5 text-[12px] outline-none focus:border-[var(--line-strong)]"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") { event.preventDefault(); void create(); }
                  }}
                  placeholder="Tag name"
                />
              </TextField>
              {duplicate && (
                <p className="mt-1 text-[10.5px] text-[var(--danger,#b42318)]">
                  Duplicate: “{duplicate.name}” already exists.
                </p>
              )}
            </div>
            <TextField aria-label="Tag description" value={description} onChange={setDescription}>
              <Input
                className="h-8 w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-2.5 text-[12px] outline-none focus:border-[var(--line-strong)]"
                placeholder="Description (optional)"
              />
            </TextField>
            <Button
              className="h-8 gap-1.5 rounded-md bg-[var(--ink)] px-3 text-[11px] text-[var(--paper)] disabled:opacity-40"
              isDisabled={!normalized || Boolean(duplicate)}
              onPress={() => void create()}
            >
              <Plus size={11} /> Create
            </Button>
          </div>
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-[var(--line)] px-3 py-2.5 text-[11px] text-[var(--ink-3)]">
          You can use existing tags. Owner or admin access is required to change the taxonomy.
        </div>
      )}

      <div className="rounded-md border border-[var(--line)]">
        {tags.map((tag) => (
          <TagRow
            key={tag.id}
            tag={tag}
            tags={tags}
            canManage={canManage}
            workspace={address}
            onChanged={load}
            applyOptimistic={applyOptimistic}
            getCanonical={getCanonical}
            setCanonical={setCanonical}
            focused={focusedTagId === tag.id}
          />
        ))}
        {tags.length === 0 && <p className="px-3 py-6 text-center text-[12px] text-[var(--ink-3)]">No tags yet.</p>}
      </div>
    </div>
  );
}

function TagRow({
  tag,
  tags,
  canManage,
  workspace,
  onChanged,
  applyOptimistic,
  getCanonical,
  setCanonical,
  focused,
}: {
  tag: ManagedTag;
  tags: ManagedTag[];
  canManage: boolean;
  workspace: WorkspaceAddress;
  onChanged: () => Promise<void>;
  applyOptimistic: (updater: (current: ManagedTag[]) => ManagedTag[]) => void;
  getCanonical: () => ManagedTag[];
  setCanonical: (next: ManagedTag[]) => void;
  focused: boolean;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(tag.name);
  const [description, setDescription] = useState(tag.description ?? "");
  const [mergeTarget, setMergeTarget] = useState("");
  // Only the destructive delete blocks its control while in flight; rename
  // and merge are optimistic and never disable.
  const [deleting, setDeleting] = useState(false);
  const duplicate = tags.some(
    (candidate) => candidate.id !== tag.id && candidate.normalized_name === normalizeTagName(name),
  );

  // Rename/merge: apply the change locally right away, persist in the
  // background, and revert to the last known-good (canonical) list if the
  // request fails — never to whatever happened to be in state, since another
  // optimistic op could have run concurrently.
  async function requestOptimistic(
    url: string,
    init: RequestInit,
    optimisticUpdate: (current: ManagedTag[]) => ManagedTag[],
    success: string,
  ) {
    const canonical = getCanonical();
    applyOptimistic(optimisticUpdate);
    setEditing(false);
    setMergeTarget("");
    try {
      const response = await fetch(url, init);
      const data = (await response.json()) as { message?: string };
      if (!response.ok) throw new Error(data.message ?? "Tag operation failed");
      await onChanged();
      toast.info(success);
    } catch (error) {
      applyOptimistic(() => canonical);
      setCanonical(canonical);
      toast.error(error instanceof Error ? error.message : "Tag operation failed");
    }
  }

  // Delete: destructive, keeps its confirmation and blocking pending state.
  async function requestDestructive(url: string, init: RequestInit, success: string) {
    setDeleting(true);
    try {
      const response = await fetch(url, init);
      const data = (await response.json()) as { message?: string };
      if (!response.ok) throw new Error(data.message ?? "Tag operation failed");
      await onChanged();
      toast.info(success);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Tag operation failed");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div data-tag-id={tag.id} className={cn("border-b border-[var(--line)] px-3 py-2.5 last:border-b-0", focused && "bg-[var(--paper-3)] ring-1 ring-inset ring-[var(--line-strong)]")}>
      {editing ? (
        <div className="grid gap-2 sm:grid-cols-[1fr_1.5fr_auto]">
          <div>
            <TextField aria-label="Tag name" value={name} onChange={setName}>
              <Input className="h-7 w-full rounded border border-[var(--line)] bg-[var(--paper-2)] px-2 text-[12px]" />
            </TextField>
            {duplicate && <span className="text-[10px] text-[var(--danger,#b42318)]">Duplicate name</span>}
          </div>
          <TextField aria-label="Tag description" value={description} onChange={setDescription}>
            <Input className="h-7 w-full rounded border border-[var(--line)] bg-[var(--paper-2)] px-2 text-[12px]" />
          </TextField>
          <div className="flex gap-1">
            <Button
              className="h-7 w-7 min-w-0 rounded border border-[var(--line)] p-0"
              isDisabled={duplicate || !normalizeTagName(name)}
              aria-label="Save"
              isIconOnly
              variant="outline"
              onPress={() => {
                const nextName = name;
                const nextDescription = description;
                void requestOptimistic(
                  `/api/tags/${tag.id}`,
                  { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspace: workspaceApiRef(workspace), name: nextName, description: nextDescription }) },
                  (current) => current.map((candidate) =>
                    candidate.id === tag.id
                      ? { ...candidate, name: nextName, normalized_name: normalizeTagName(nextName), description: nextDescription || null }
                      : candidate,
                  ),
                  "Tag updated.",
                );
              }}
            >
              <Check size={11} />
            </Button>
            <Button
              className="h-7 w-7 min-w-0 rounded border border-[var(--line)] p-0"
              aria-label="Cancel"
              isIconOnly
              variant="outline"
              onPress={() => setEditing(false)}
            >
              <X size={11} />
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[12.5px]"><TagColorDot tagId={tag.id} /><span className="font-medium">#{tag.name}</span><span className="mono text-[9.5px] text-[var(--ink-mute)]">{tag.usage_count} nodes · {tag.slug}</span></div>
            {tag.description && <p className="mt-0.5 text-[11px] text-[var(--ink-3)]">{tag.description}</p>}
          </div>
          {canManage && (
            <>
              <Button
                className="h-7 w-7 min-w-0 rounded p-0 hover:bg-[var(--paper-2)]"
                aria-label="Rename"
                isIconOnly
                variant="ghost"
                onPress={() => setEditing(true)}
              >
                <Pencil size={11} />
              </Button>
              <Select
                aria-label="Merge into"
                className="max-w-[140px]"
                placeholder="Merge into…"
                value={mergeTarget || null}
                onChange={(key) => setMergeTarget(key ? String(key) : "")}
              >
                <Select.Trigger className="mono h-7 max-w-[140px] rounded border border-[var(--line)] bg-[var(--paper)] px-1.5 text-[9.5px]">
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {tags.filter((candidate) => candidate.id !== tag.id).map((candidate) => (
                      <ListBox.Item key={candidate.id} id={candidate.id} textValue={candidate.name}>
                        {candidate.name}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
              <Button
                className="h-7 w-7 min-w-0 rounded p-0"
                isDisabled={!mergeTarget}
                aria-label="Merge"
                isIconOnly
                variant="ghost"
                onPress={() => {
                  const targetId = mergeTarget;
                  void requestOptimistic(
                    `/api/tags/${tag.id}/merge`,
                    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspace: workspaceApiRef(workspace), target_id: targetId }) },
                    (current) => current
                      .filter((candidate) => candidate.id !== tag.id)
                      .map((candidate) =>
                        candidate.id === targetId
                          ? { ...candidate, usage_count: candidate.usage_count + tag.usage_count }
                          : candidate,
                      ),
                    "Tags merged.",
                  );
                }}
              >
                <Merge size={11} />
              </Button>
              <Button
                className="h-7 w-7 min-w-0 rounded p-0 text-[var(--ink-3)] hover:text-[var(--danger,#b42318)]"
                isDisabled={deleting}
                aria-label="Delete"
                isIconOnly
                variant="ghost"
                onPress={() => { if (window.confirm(`Delete #${tag.name}? It will be removed from ${tag.usage_count} nodes.`)) void requestDestructive(`/api/tags/${tag.id}?workspace=${encodeURIComponent(workspaceApiRef(workspace))}`, { method: "DELETE" }, "Tag deleted."); }}
              >
                <Trash2 size={11} />
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
