"use client";

/**
 * ⌘K — jump to a node. Mounted once in `workspace-shell.tsx`; also opened by
 * the `bcontext:open-command-palette` window event (sidebar search button).
 *
 * Entirely client-side: it scores `useWorkspace().nodes` (title, slug and
 * body are already in memory) with a small fuzzy matcher, so there is no
 * request per keystroke. Three modes inferred from the query — `jump`
 * (one word: titles), `search` (spaces: titles + body with a snippet) and
 * `tag` (`#…`: direct tag membership) — with Tab cycling them explicitly.
 * Picking a hit opens the node in the floating panel. Semantic search is
 * Nexo's job (⌘J), which the empty state points at.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Bug,
  CheckSquare,
  FileText,
  GitBranch,
  Search,
  Sparkles,
  Target,
  Wand2,
} from "lucide-react";
import { Command } from "@/components/ui/command";
import { Kbd } from "@heroui/react";
import { getNodeTags, type KnowledgeNode, type NodeKind } from "@bcontext-dev/contract/types";
import { useWorkspace } from "./workspace-context";

function iconFor(kind: NodeKind) {
  switch (kind) {
    case "doc":
      return FileText;
    case "task":
      return CheckSquare;
    case "decision":
    case "adr":
      return GitBranch;
    case "bug":
      return Bug;
    case "meeting":
      return Sparkles;
    case "skill":
      return Wand2;
    case "goal":
      return Target;
    default:
      return FileText;
  }
}

type Mode = "jump" | "search" | "tag";

interface Hit {
  node: KnowledgeNode;
  score: number;
  snippet: string | null;
}

function fuzzyScore(haystack: string, needle: string): number {
  if (!needle) return 0;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  const idx = h.indexOf(n);
  if (idx === -1) {
    // letter-by-letter fuzzy fallback
    let hi = 0;
    let matched = 0;
    for (let ni = 0; ni < n.length; ni++) {
      const c = n.charAt(ni);
      const found = h.indexOf(c, hi);
      if (found === -1) return 0;
      matched++;
      hi = found + 1;
    }
    return matched / (h.length + 1);
  }
  // direct substring hit: prefer earlier matches and shorter strings
  return 1000 - idx - h.length * 0.01;
}

function jumpScore(node: KnowledgeNode, needle: string): number {
  if (!needle) return 0;
  const titleScore = fuzzyScore(node.title, needle);
  const slugScore = fuzzyScore(node.slug, needle) * 0.6;
  const prefixBoost = node.title.toLowerCase().startsWith(needle.toLowerCase())
    ? 500
    : 0;
  return titleScore + slugScore + prefixBoost;
}

function makeSnippet(content: string, q: string): string | null {
  if (!content) return null;
  const lower = content.toLowerCase();
  const idx = lower.indexOf(q.toLowerCase());
  if (idx === -1) return null;
  const start = Math.max(0, idx - 30);
  const end = Math.min(content.length, idx + q.length + 60);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  return prefix + content.slice(start, end).replace(/\s+/g, " ") + suffix;
}

function inferMode(query: string): Mode {
  const trimmed = query.trim();
  if (!trimmed) return "jump";
  if (trimmed.startsWith("#")) return "tag";
  if (/\s/.test(trimmed)) return "search";
  return /^[a-z]/i.test(trimmed) ? "jump" : "search";
}

export function CommandPalette() {
  const { nodes, selectNode } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [modeOverride, setModeOverride] = useState<Mode | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      // ⌘⇧K is the create-node dialog's (create-node-dialog-host.tsx).
      if (meta && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    function onOpen() {
      setOpen(true);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("bcontext:open-command-palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("bcontext:open-command-palette", onOpen);
    };
  }, []);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setModeOverride(null);
    }
  }, [open]);

  const mode: Mode = modeOverride ?? inferMode(query);

  const hits = useMemo<Hit[]>(() => {
    const q = query.trim();
    if (!q) {
      // Empty query: folders are normal nodes and remain directly findable.
      return nodes
        .slice(0, 8)
        .map((node) => ({ node, score: 0, snippet: null }));
    }
    const scored: Hit[] = [];
    if (mode === "tag") {
      // Strip leading "#" and any whitespace; empty payload lists every
      // tagged node so the user can browse the tag space.
      const needle = q.replace(/^#+/, "").trim().toLowerCase();
      for (const node of nodes) {
        const tags = getNodeTags(node);
        if (tags.length === 0) continue;
        if (!needle) {
          scored.push({
            node,
            score: tags.length,
            snippet: tags.map((t) => `#${t}`).join(" "),
          });
          continue;
        }
        // Exact membership wins; prefix match is the soft fallback.
        const exact = tags.includes(needle);
        const prefix = !exact && tags.some((t) => t.startsWith(needle));
        if (exact || prefix) {
          scored.push({
            node,
            score: exact ? 2000 : 1000,
            snippet: tags.map((t) => `#${t}`).join(" "),
          });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, 30);
    }
    if (mode === "jump") {
      for (const node of nodes) {
        const total = jumpScore(node, q);
        if (total > 0) {
          scored.push({ node, score: total, snippet: null });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, 8);
    }
    // search mode: title + content
    for (const node of nodes) {
      const titleScore = fuzzyScore(node.title, q);
      const contentScore = fuzzyScore(node.content_md, q) * 0.2;
      const total = titleScore + contentScore;
      if (total > 0) {
        scored.push({
          node,
          score: total,
          snippet: titleScore > 0 ? null : makeSnippet(node.content_md, q),
        });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 30);
  }, [nodes, query, mode]);

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Tab") return;
    e.preventDefault();
    // Tab cycles jump → search → tag → jump. Auto-injects "#" when entering
    // tag mode so the placeholder + filter behaviour is consistent.
    const next: Mode =
      mode === "jump" ? "search" : mode === "search" ? "tag" : "jump";
    setModeOverride(next);
    if (next === "tag" && !query.startsWith("#")) {
      setQuery("#" + query.replace(/^#+/, ""));
    } else if (next !== "tag" && query.startsWith("#")) {
      setQuery(query.replace(/^#+/, ""));
    }
  }

  const placeholder =
    mode === "jump"
      ? "Jump to a node…"
      : mode === "tag"
        ? "#tag — filter by tag…"
        : "Search node content…";
  const modeLabel =
    mode === "jump" ? "Jump" : mode === "tag" ? "Tag" : "Search";

  return (
    <Command>
      <Command.Backdrop isOpen={open} onOpenChange={setOpen} variant="blur">
        <Command.Container size="lg">
          <Command.Dialog inputValue={query} onInputChange={setQuery} filter={() => true}>
            <Command.InputGroup>
              <Command.InputGroup.Prefix>
                <Search size={15} className="text-[var(--ink-3)]" />
              </Command.InputGroup.Prefix>
              <Command.InputGroup.Input
                placeholder={placeholder}
                onKeyDown={onInputKeyDown}
                className="text-[14.5px] text-[var(--ink)] placeholder:text-[var(--ink-mute)]"
              />
              <Command.InputGroup.Suffix>
                <span className="mono inline-flex items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--paper-2)] px-2.5 py-0.5 text-[11px] text-[var(--ink-2)]">
                  <span className="lowercase">{modeLabel}</span>
                </span>
              </Command.InputGroup.Suffix>
            </Command.InputGroup>
            <Command.List
              onAction={(key) => {
                setOpen(false);
                selectNode(String(key));
              }}
              renderEmptyState={() => (
                <div className="px-8 py-8 text-center text-[12px] text-[var(--ink-3)]">
                  No matches. Nexo can look for it — ⌘J.
                </div>
              )}
            >
              {hits.length > 0 ? (
                <Command.Group heading="Nodes">
                  {hits.map((hit) => {
                    const Icon = iconFor(hit.node.kind);
                    return (
                      <Command.Item key={hit.node.id} id={hit.node.id} textValue={hit.node.title}>
                        <Icon size={14} className="shrink-0 text-[var(--ink-3)]" />
                        <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--ink)]">
                          {hit.node.title}
                        </span>
                        <span className="mono max-w-[45%] shrink-0 truncate text-[11px] text-[var(--ink-3)]">
                          {hit.node.kind} · /n/{hit.node.slug}
                        </span>
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              ) : null}
            </Command.List>
            <Command.Footer className="flex items-center gap-3.5 text-[11px] text-[var(--ink-3)]">
              <span className="inline-flex items-center gap-1.5">
                <Kbd><Kbd.Content>↑↓</Kbd.Content></Kbd> navigate
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Kbd><Kbd.Content>↵</Kbd.Content></Kbd> open
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Kbd><Kbd.Content>tab</Kbd.Content></Kbd> cycle mode
              </span>
              <span className="ml-auto inline-flex items-center gap-1.5">
                <Kbd><Kbd.Content>esc</Kbd.Content></Kbd> dismiss
              </span>
            </Command.Footer>
          </Command.Dialog>
        </Command.Container>
      </Command.Backdrop>
    </Command>
  );
}
