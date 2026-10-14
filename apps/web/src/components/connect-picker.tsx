"use client";

/**
 * "Connect to" — the one search box through which a node being created is
 * attached to the rest of the workspace. Used by `create-node-dialog.tsx`
 * on every step that ends in a create. It replaces a native `<select>`
 * that listed every node in the workspace, which stopped being usable
 * somewhere around the hundredth node.
 *
 * One query, two groups of results: **Nodes** (title match, case- and
 * diacritic-insensitive; picking one makes it the node's parent — there is
 * exactly one parent, so a second pick replaces the first) and **Tags**
 * (picking one adds it; several can be added). What is chosen shows as
 * removable chips inside the field, the parent labelled as such. Parent +
 * tags is the whole connection surface on purpose: the web has no edge
 * endpoint, and mentions in the body link nodes later anyway.
 *
 * The results list is a plain `role="listbox"` driven from the input via
 * `aria-activedescendant` rather than a HeroUI ComboBox/Popover: the
 * picker lives inside a Modal whose focus scope must keep owning focus,
 * and a virtual-focus list inside the dialog's own DOM is the one shape
 * that never fights it. Keyboard: ↑/↓ move, Enter picks, Esc closes the
 * list (and only the list — it stops there so the Modal stays open),
 * Backspace on an empty query removes the last chip.
 *
 * `searchConnections` is pure and unit-tested (`connect-picker.test.ts`);
 * keep matching and ranking in it, not in the component.
 */

import { useCallback, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CornerLeftUp, Hash, X } from "lucide-react";
import { Chip, Label } from "@heroui/react";
import type { KnowledgeNode, WorkspaceTag } from "@bcontext-dev/contract/types";
import { cn } from "@bcontext-dev/contract/utils";
import { nodeKindIcon } from "./node-kind-icon";
import { TagColorDot } from "./tag-color-dot";

/** The slice of a node the picker needs — tests build these by hand. */
export type ConnectNode = Pick<KnowledgeNode, "id" | "title" | "kind" | "updated_at">;
/** The slice of a tag the picker needs. */
export type ConnectTag = Pick<WorkspaceTag, "id" | "name" | "normalized_name">;

export interface ConnectValue {
  parentId: string | null;
  tagIds: string[];
}

export interface ConnectResults<N extends ConnectNode = ConnectNode, T extends ConnectTag = ConnectTag> {
  nodes: N[];
  tags: T[];
}

const NODE_LIMIT = 8;
const TAG_LIMIT = 5;
const RECENT_LIMIT = 5;

/** Lower-case, accents stripped, whitespace collapsed: "Résumé  X" → "resume x". */
export function foldText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * How well a folded haystack matches a folded needle: 0 = starts with it,
 * 1 = a word starts with it, 2 = contains it anywhere, -1 = no match.
 * Lower is better so results can be sorted by it directly.
 */
export function matchRank(haystack: string, needle: string): number {
  if (!needle) return 2;
  if (haystack.startsWith(needle)) return 0;
  if (haystack.includes(` ${needle}`)) return 1;
  if (haystack.includes(needle)) return 2;
  return -1;
}

/**
 * The grouped results for a query. Nodes are ranked by match quality, then
 * most recently updated first; tags by match quality, then name. An empty
 * query returns the most recently updated nodes and no tags — something to
 * pick before typing, without listing the whole taxonomy. Anything already
 * chosen is left out so a chip is never offered twice.
 */
export function searchConnections<N extends ConnectNode, T extends ConnectTag>(
  query: string,
  nodes: readonly N[],
  tags: readonly T[],
  exclude: { nodeIds?: Iterable<string>; tagIds?: Iterable<string> } = {},
): ConnectResults<N, T> {
  const needle = foldText(query);
  const skipNodes = new Set(exclude.nodeIds ?? []);
  const skipTags = new Set(exclude.tagIds ?? []);
  const byRecency = (a: ConnectNode, b: ConnectNode) => b.updated_at.localeCompare(a.updated_at);

  if (!needle) {
    return {
      nodes: nodes
        .filter((node) => !skipNodes.has(node.id))
        .toSorted(byRecency)
        .slice(0, RECENT_LIMIT),
      tags: [],
    };
  }

  const rankedNodes = nodes
    .filter((node) => !skipNodes.has(node.id))
    .map((node) => ({ node, rank: matchRank(foldText(node.title), needle) }))
    .filter((entry) => entry.rank >= 0)
    .toSorted((a, b) => a.rank - b.rank || byRecency(a.node, b.node))
    .slice(0, NODE_LIMIT)
    .map((entry) => entry.node);

  const rankedTags = tags
    .filter((tag) => !skipTags.has(tag.id))
    .map((tag) => ({ tag, rank: matchRank(foldText(tag.normalized_name || tag.name), needle) }))
    .filter((entry) => entry.rank >= 0)
    .toSorted((a, b) => a.rank - b.rank || a.tag.name.localeCompare(b.tag.name))
    .slice(0, TAG_LIMIT)
    .map((entry) => entry.tag);

  return { nodes: rankedNodes, tags: rankedTags };
}

type Option =
  | { kind: "node"; id: string; node: ConnectNode }
  | { kind: "tag"; id: string; tag: ConnectTag };

export function ConnectPicker({
  nodes,
  tags,
  value,
  onChange,
  isDisabled = false,
}: {
  nodes: readonly ConnectNode[];
  tags: readonly ConnectTag[];
  value: ConnectValue;
  onChange: (next: ConnectValue) => void;
  isDisabled?: boolean;
}) {
  const baseId = useId();
  const inputId = `${baseId}-input`;
  const listId = `${baseId}-list`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const parent = useMemo(
    () => (value.parentId ? nodes.find((node) => node.id === value.parentId) ?? null : null),
    [nodes, value.parentId],
  );
  const chosenTags = useMemo(
    () => value.tagIds.map((id) => tags.find((tag) => tag.id === id)).filter((tag): tag is ConnectTag => Boolean(tag)),
    [tags, value.tagIds],
  );

  const results = useMemo(
    () => searchConnections(query, nodes, tags, { nodeIds: value.parentId ? [value.parentId] : [], tagIds: value.tagIds }),
    [query, nodes, tags, value.parentId, value.tagIds],
  );
  const options = useMemo<Option[]>(
    () => [
      ...results.nodes.map((node): Option => ({ kind: "node", id: `${baseId}-n-${node.id}`, node })),
      ...results.tags.map((tag): Option => ({ kind: "tag", id: `${baseId}-t-${tag.id}`, tag })),
    ],
    [results, baseId],
  );

  const pick = useCallback(
    (option: Option) => {
      if (option.kind === "node") onChange({ ...value, parentId: option.node.id });
      else onChange({ ...value, tagIds: [...value.tagIds, option.tag.id] });
      setQuery("");
      setActive(0);
      setOpen(false);
      inputRef.current?.focus();
    },
    [onChange, value],
  );

  const removeParent = useCallback(() => onChange({ ...value, parentId: null }), [onChange, value]);
  const removeTag = useCallback(
    (id: string) => onChange({ ...value, tagIds: value.tagIds.filter((tagId) => tagId !== id) }),
    [onChange, value],
  );

  const showList = open && options.length > 0;
  // The highlighted row is an index into the current results; a result set
  // that shrank underneath it (nodes arriving, a chip removed) clamps rather
  // than pointing past the end.
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));
  const activeOption = options[activeIndex];

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!showList) setOpen(true);
      else setActive((activeIndex + 1) % options.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (showList) setActive((activeIndex - 1 + options.length) % options.length);
      return;
    }
    if (event.key === "Enter") {
      // Enter belongs to the list while it is open; with it closed the
      // event bubbles to whoever submits the form.
      if (!showList) return;
      event.preventDefault();
      if (activeOption) pick(activeOption);
      return;
    }
    if (event.key === "Escape") {
      if (!showList) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (event.key === "Backspace" && query === "") {
      if (value.tagIds.length > 0) {
        event.preventDefault();
        removeTag(value.tagIds[value.tagIds.length - 1]!);
      } else if (value.parentId) {
        event.preventDefault();
        removeParent();
      }
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={inputId}>Connect to</Label>
      <div className="relative">
        <div
          className={cn(
            "flex min-h-9 flex-wrap items-center gap-1 rounded-md border border-[var(--line)] bg-[var(--paper-2)] px-1.5 py-1 focus-within:border-[var(--line-strong)]",
            isDisabled && "opacity-60",
          )}
          onClick={() => inputRef.current?.focus()}
        >
          {parent ? (
            <ValueChip label={`Parent · ${parent.title}`} onRemove={removeParent} isDisabled={isDisabled}>
              <CornerLeftUp size={10} className="shrink-0 opacity-60" />
            </ValueChip>
          ) : null}
          {chosenTags.map((tag) => (
            <ValueChip key={tag.id} label={tag.name} onRemove={() => removeTag(tag.id)} isDisabled={isDisabled}>
              <TagColorDot tagId={tag.id} />
            </ValueChip>
          ))}
          <input
            ref={inputRef}
            id={inputId}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={showList}
            aria-controls={showList ? listId : undefined}
            aria-activedescendant={showList ? activeOption?.id : undefined}
            aria-label="Connect to a parent node or tags"
            autoComplete="off"
            disabled={isDisabled}
            value={query}
            placeholder={parent || chosenTags.length ? "Add more…" : "Search nodes and tags…"}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={onKeyDown}
            className="h-7 min-w-[8rem] flex-1 bg-transparent px-1 text-[13px] text-[var(--ink)] outline-none placeholder:text-[var(--ink-3)]"
          />
        </div>

        {showList ? (
          <div
            id={listId}
            role="listbox"
            aria-label="Nodes and tags"
            className="absolute inset-x-0 top-full z-10 mt-1 max-h-64 overflow-y-auto rounded-lg border border-[var(--line)] bg-[var(--paper)] p-1 shadow-[0_14px_40px_rgba(0,0,0,0.18)]"
          >
            {results.nodes.length > 0 ? (
              <ResultGroup id={`${baseId}-g-nodes`} label={query ? "Nodes" : "Recent"}>
                {results.nodes.map((node) => {
                  const option = options.find((entry) => entry.kind === "node" && entry.node.id === node.id)!;
                  const Icon = nodeKindIcon(node.kind);
                  return (
                    <ResultRow
                      key={option.id}
                      id={option.id}
                      isActive={activeOption?.id === option.id}
                      onHover={() => setActive(options.indexOf(option))}
                      onPick={() => pick(option)}
                    >
                      <Icon size={12} className="shrink-0 text-[var(--ink-3)]" />
                      <span className="min-w-0 flex-1 truncate">{node.title}</span>
                      <span className="mono shrink-0 text-[10px] text-[var(--ink-mute)]">{node.kind}</span>
                    </ResultRow>
                  );
                })}
              </ResultGroup>
            ) : null}
            {results.tags.length > 0 ? (
              <ResultGroup id={`${baseId}-g-tags`} label="Tags">
                {results.tags.map((tag) => {
                  const option = options.find((entry) => entry.kind === "tag" && entry.tag.id === tag.id)!;
                  return (
                    <ResultRow
                      key={option.id}
                      id={option.id}
                      isActive={activeOption?.id === option.id}
                      onHover={() => setActive(options.indexOf(option))}
                      onPick={() => pick(option)}
                    >
                      <Hash size={11} className="shrink-0 text-[var(--ink-3)]" />
                      <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                      <TagColorDot tagId={tag.id} />
                    </ResultRow>
                  );
                })}
              </ResultGroup>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** One chosen thing inside the field: leading glyph, label, remove. */
function ValueChip({
  label,
  onRemove,
  isDisabled,
  children,
}: {
  label: string;
  onRemove: () => void;
  isDisabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <Chip size="sm" variant="soft" className="max-w-full gap-1 pr-1">
      {children}
      <Chip.Label className="truncate">{label}</Chip.Label>
      <button
        type="button"
        aria-label={`Remove ${label}`}
        disabled={isDisabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.stopPropagation();
          onRemove();
        }}
        className="rounded-full p-0.5 opacity-50 hover:bg-[var(--paper-3)] hover:opacity-100"
      >
        <X size={9} />
      </button>
    </Chip>
  );
}

function ResultGroup({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-labelledby={id}>
      <div id={id} className="mono px-2 pb-1 pt-1.5 text-[9.5px] uppercase tracking-[0.08em] text-[var(--ink-mute)]">
        {label}
      </div>
      {children}
    </div>
  );
}

function ResultRow({
  id,
  isActive,
  onHover,
  onPick,
  children,
}: {
  id: string;
  isActive: boolean;
  onHover: () => void;
  onPick: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={isActive}
      onMouseEnter={onHover}
      // mousedown would move focus off the input and close the list before
      // the click lands; picking on mousedown keeps the field focused.
      onMouseDown={(event) => {
        event.preventDefault();
        onPick();
      }}
      className={cn(
        "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] text-[var(--ink)]",
        isActive && "bg-[var(--paper-2)]",
      )}
    >
      {children}
    </div>
  );
}
