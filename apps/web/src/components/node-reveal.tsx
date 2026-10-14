"use client";

/**
 * Inline hover-dwell reveal shared by the list rows (saved-list-view.tsx)
 * and board cards (board-renderer.tsx): after the dwell (`use-hover-dwell`)
 * the row/card itself expands in place to show summary · tags · status. An
 * in-place expansion rather than a floating card so the item stays a plain
 * child of its collection (selection, keyboard navigation and drag keep
 * working) and nothing overlays the surface.
 *
 * The summary is the first lines of the node's content, fetched once per id
 * from `/inspector?scope=preview` and cached for the session (module-level
 * map). Tags and status come from the caller — they are already on the row.
 *
 * Animation is the collapsible-panel technique used by the Filters panel in
 * saved-list-view.tsx: a `grid` wrapper animating `grid-template-rows`
 * between `0fr` and `1fr` around an `overflow-hidden` inner div, with a
 * subtle opacity/translate fade on the innermost content.
 */

import { useEffect, useState } from "react";
import { Chip } from "@heroui/react";
import { statusLabel, type NodeStatus } from "@bcontext-dev/contract/types";
import type { NodeInspectorPayload } from "@bcontext-dev/contract/node-inspector";
import { cn } from "@bcontext-dev/contract/utils";
import { workspaceApiRef, type WorkspaceAddress } from "@/web/workspace-url";

// Module-level so re-hovering the same node across renders/remounts within
// the session skips the network round-trip entirely. Only successful reads
// are cached — a transient fetch failure should not stick permanently.
const summaryCache = new Map<string, string | null>();

/** Strips a leading `---\n...\n---` YAML frontmatter block, if present. */
function stripFrontmatter(md: string): string {
  const lines = md.split("\n");
  if (lines[0]?.trim() !== "---") return md;
  const closingIndex = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (closingIndex === -1) return md;
  return lines.slice(closingIndex + 2).join("\n");
}

function summarizeContentMd(md: string): string | null {
  const body = stripFrontmatter(md);
  if (!body) return null;
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
  const summary = lines.slice(0, 3).join(" ");
  return summary.length > 220 ? `${summary.slice(0, 217)}…` : summary;
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

/**
 * The animated reveal region: renders collapsed (zero height, inert) unless
 * `open`, in which case it lazy-fetches the node's content summary (once,
 * cached) and shows summary + tags + status. Meant to sit directly below a
 * row/card's title inside its own layout.
 */
export function NodeRevealRegion({
  open,
  nodeId,
  workspace,
  tags,
  status,
  className,
}: {
  open: boolean;
  nodeId: string;
  workspace: WorkspaceAddress;
  tags: string[];
  status: NodeStatus | null;
  className?: string;
}) {
  const [summary, setSummary] = useState<string | null>(() => summaryCache.get(nodeId) ?? null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (summaryCache.has(nodeId)) {
      setSummary(summaryCache.get(nodeId) ?? null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchNodeSummary(nodeId, workspace)
      .then((result) => {
        if (!cancelled) setSummary(result);
      })
      .catch(() => {
        // Peek stays limited to tags/status already rendered below.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, nodeId, workspace]);

  return (
    <div
      inert={!open}
      className={cn(
        "grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        className,
      )}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          className={cn(
            "space-y-1.5 pt-1.5 transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
            open ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0",
          )}
        >
          <p className="line-clamp-3 text-[11.5px] leading-snug text-[var(--ink-3)]">
            {loading ? "Loading preview…" : (summary ?? "No content yet.")}
          </p>
          {tags.length > 0 || status ? (
            <div className="flex flex-wrap items-center gap-1">
              {status ? (
                <Chip size="sm" variant="soft">
                  <Chip.Label>{statusLabel(status)}</Chip.Label>
                </Chip>
              ) : null}
              {tags.slice(0, 6).map((tag) => (
                <Chip key={tag} size="sm" variant="soft">
                  <Chip.Label>#{tag}</Chip.Label>
                </Chip>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
