"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button, ComboBox, Input, ListBox, Tag, TagGroup } from "@heroui/react";
import { cn } from "@bcontext-dev/contract/utils";
import { getNodeMentions, type KnowledgeNode } from "@bcontext-dev/contract/types";
import {
  buildMentionCandidates,
  searchMentions,
  type MentionCandidate,
} from "@bcontext-dev/contract/mention-search";
import { useToast } from "./workspace-context";
import { workspacePath, workspaceApiRef, type WorkspaceAddress } from "@/web/workspace-url";

/**
 * Explicit mentions on the `/n/<id>` node page: a way to connect this node
 * to others without dropping a link inline in the body. Each mention is a
 * pill with a leading `+`; "+ Add mention" opens the same candidate list the
 * editor shows behind `@` (`mention-search` in the contract), filtered live
 * as the user types. Enter, Tab or click commits.
 *
 * Persisted in `node.data.mentions` as an array of node ids, through a plain
 * `PATCH /api/nodes/:id` of `data` — optimistic, reverted on failure. The
 * contract's backlink builder reads that array next to the links in the
 * body, so an explicit mention counts as a connection everywhere.
 */
export function MentionsEditor({
  node,
  workspace,
  allNodes,
}: {
  node: KnowledgeNode;
  workspace: WorkspaceAddress;
  allNodes: KnowledgeNode[];
}) {
  const router = useRouter();
  const toast = useToast();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [mentions, setMentions] = useState<string[]>(getNodeMentions(node));
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const dirtyRef = useRef(false);
  // Last server-confirmed mention list. Reverts restore this snapshot (not a
  // possibly-stale local var) so two rapid add/remove ops can't clobber
  // each other's result when one of them fails.
  const canonicalRef = useRef<string[]>(getNodeMentions(node));

  useEffect(() => {
    if (dirtyRef.current) return;
    const next = getNodeMentions(node);
    canonicalRef.current = next;
    setMentions(next);
  }, [node]);

  const nodeById = useMemo(() => {
    const m = new Map<string, KnowledgeNode>();
    for (const n of allNodes) m.set(n.id, n);
    return m;
  }, [allNodes]);

  const candidates = useMemo(
    () => buildMentionCandidates(allNodes, node.id),
    [allNodes, node.id],
  );

  const filtered = useMemo(() => {
    const excluded = new Set(mentions);
    const pool = candidates.filter((c) => !excluded.has(c.id));
    return searchMentions(query, pool);
  }, [candidates, mentions, query]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!containerRef.current) return;
      if (containerRef.current.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const persist = useCallback(
    async (next: string[]) => {
      // Optimistic: reflect the mention change instantly, persist in the
      // background, revert to the last known-good (canonical) list on
      // failure.
      setSaving(true);
      dirtyRef.current = true;
      setMentions(next);
      try {
        const existing =
          node.data && typeof node.data === "object" && !Array.isArray(node.data)
            ? (node.data as Record<string, unknown>)
            : {};
        const nextData = { ...existing, mentions: next };
        const response = await fetch(`/api/nodes/${encodeURIComponent(node.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspace: workspaceApiRef(workspace), data: nextData }),
        });
        if (!response.ok) throw new Error("mention update failed");
        canonicalRef.current = next;
        router.refresh();
      } catch {
        setMentions(canonicalRef.current);
        toast.error("Couldn’t update mentions.");
      } finally {
        setSaving(false);
      }
    },
    [node, workspace, router, toast],
  );

  const addMention = useCallback(
    (id: string) => {
      if (mentions.includes(id)) return;
      setQuery("");
      void persist([...mentions, id]);
    },
    [mentions, persist],
  );

  const removeMention = useCallback(
    (id: string) => {
      void persist(mentions.filter((m) => m !== id));
    },
    [mentions, persist],
  );

  function commitFromInput() {
    const item = filtered[0];
    if (item) {
      addMention(item.id);
      return;
    }
    // Fall back to exact-title match if the user typed the full title and
    // the top row doesn't match (e.g. filtering hid it).
    if (query.trim()) {
      const exact = candidates.find(
        (c) => c.title.toLowerCase() === query.trim().toLowerCase(),
      );
      if (exact && !mentions.includes(exact.id)) {
        addMention(exact.id);
      }
    }
  }

  function openMenu() {
    setOpen(true);
    setQuery("");
  }

  return (
    <div
      ref={containerRef}
      className="relative mt-2 flex flex-wrap items-center gap-1"
      aria-label="Mentions"
    >
      <TagGroup
        aria-label="Selected mentions"
        selectionMode="none"
        size="sm"
        onRemove={(keys) => void persist(mentions.filter((id) => !keys.has(id)))}
      >
        <TagGroup.List className="flex flex-wrap items-center gap-1" items={mentions.map((id) => ({ id }))}>
          {({ id }) => {
            const target = nodeById.get(id);
            const title = target?.title ?? "Unknown";
            return (
              <Tag
                key={id}
                id={id}
                textValue={title}
                className="gap-0.5 rounded border border-[var(--border)] bg-[var(--bg-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--fg-muted)]"
              >
                <Plus size={9} className="text-[var(--fg-subtle)]" />
                <a
                  href={target ? workspacePath(workspace, `n/${target.id}`) : undefined}
                  className="ml-0.5 text-[var(--fg)] hover:underline"
                  title={title}
                >
                  {title}
                </a>
              </Tag>
            );
          }}
        </TagGroup.List>
      </TagGroup>

      <Button
        variant="ghost"
        onPress={openMenu}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "mono h-auto min-w-0 gap-1 rounded border border-dashed border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--fg-subtle)] hover:border-[var(--fg-subtle)] hover:text-[var(--fg)]",
          open && "border-[var(--fg-subtle)] text-[var(--fg)]",
        )}
      >
        <Plus size={10} />
        <span>{mentions.length === 0 ? "Add mention" : "Add"}</span>
      </Button>

      {saving && (
        <span className="text-[9px] uppercase tracking-widest text-[var(--fg-subtle)]">
          saving
        </span>
      )}

      {open && (
        <ComboBox
          className="absolute left-0 top-full z-30 mt-1 w-[320px] max-w-[90vw]"
          defaultFilter={() => true}
          inputValue={query}
          menuTrigger="focus"
          onInputChange={setQuery}
          onSelectionChange={(key) => {
            if (key == null) return;
            addMention(key as string);
          }}
        >
          <ComboBox.InputGroup className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 shadow-lg">
            <Input
              autoFocus
              aria-label="Search nodes to mention"
              placeholder="Search nodes…"
              className="h-5 w-full bg-transparent text-[12px] outline-none placeholder:text-[var(--fg-subtle)]"
              onKeyDown={(e) => {
                // React Aria's ComboBox owns ArrowUp/Down + Enter
                // navigation and selection. We only special-case Tab
                // (commit like Enter) and Backspace-to-remove-last-pill,
                // which aren't part of its default keyboard contract.
                if (e.key === "Tab" && query.trim()) {
                  e.preventDefault();
                  commitFromInput();
                } else if (e.key === "Backspace" && query === "" && mentions.length > 0) {
                  e.preventDefault();
                  removeMention(mentions[mentions.length - 1]!);
                }
              }}
            />
          </ComboBox.InputGroup>
          <ComboBox.Popover className="mt-1 max-h-[260px] w-[320px] max-w-[90vw] overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--bg)] py-1 text-sm shadow-lg">
            <ListBox
              renderEmptyState={() => (
                <p className="px-3 py-2 text-xs text-[var(--fg-subtle)]">
                  {candidates.length === 0
                    ? "No nodes in this workspace"
                    : "No matching nodes"}
                </p>
              )}
            >
              {filtered.map((item) => (
                <ListBox.Item
                  key={item.id}
                  id={item.id}
                  textValue={item.title}
                  className="flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left transition-colors data-[focused]:bg-[var(--bg-muted)] data-[focused]:text-[var(--fg)]"
                >
                  <MentionRowContent item={item} />
                </ListBox.Item>
              ))}
            </ListBox>
          </ComboBox.Popover>
        </ComboBox>
      )}
    </div>
  );
}

function MentionRowContent({ item }: { item: MentionCandidate }) {
  return (
    <span className="flex w-full flex-col items-start gap-0.5" title={item.snippet || item.title}>
      <span className="flex w-full items-center gap-2">
        <span className="truncate text-[13px] text-[var(--fg)]">{item.title}</span>
        <span className="ml-auto shrink-0 rounded bg-[var(--bg-muted)] px-1 text-[9px] uppercase tracking-wide text-[var(--fg-subtle)]">
          {item.kind}
        </span>
      </span>
      {item.snippet && (
        <span className="line-clamp-1 text-[11px] text-[var(--fg-subtle)]">{item.snippet}</span>
      )}
    </span>
  );
}
