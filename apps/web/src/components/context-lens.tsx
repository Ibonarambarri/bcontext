"use client";

/**
 * The Backlinks section of a node: incoming references and outgoing mentions
 * merged into one list, each entry saying which direction it runs. Rendered
 * by `node-backlinks.tsx` with the lists it fetched; this file is pure
 * presentation and opens entries either through `onOpen` (the floating
 * panel) or, without it, as plain links to the node page.
 */
import { useMemo } from "react";
import { Chip, Kbd, Separator } from "@heroui/react";
import {
  ArrowDownRight,
  ArrowUpRight,
  Bug,
  CheckSquare,
  FileText,
  GitBranch,
  Quote,
  Target,
  Wand2,
} from "lucide-react";
import type { Backlink } from "@bcontext-dev/contract/backlinks";
import type { NodeKind } from "@bcontext-dev/contract/types";
import { workspacePath, type WorkspaceAddress } from "@/web/workspace-url";

function kindIcon(kind: NodeKind) {
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
      return Quote;
    case "skill":
      return Wand2;
    case "goal":
      return Target;
    default:
      return FileText;
  }
}

/** One merged connection; `direction` is `both` when the link runs each way. */
export interface ListEntry {
  id: string;
  title: string;
  kind: NodeKind;
  direction: "in" | "out" | "both";
  block_id: string | null;
}

export function ContextConnections({
  backlinks,
  forwardLinks = [],
  workspace,
  onOpen,
}: {
  backlinks: Backlink[];
  forwardLinks?: Backlink[];
  workspace: WorkspaceAddress;
  onOpen?: (id: string, blockId: string | null) => void;
}) {
  const entries = useMemo(
    () => mergeContextConnections(backlinks, forwardLinks),
    [backlinks, forwardLinks],
  );
  return (
    <ContextSection title="Backlinks" count={entries.length}>
      {entries.length === 0 && (
        <div className="text-[12px] text-[var(--ink-3)]">
          No backlinks yet — use <Kbd><Kbd.Content>@</Kbd.Content></Kbd> in the editor
          to link another node.
        </div>
      )}
      {entries.slice(0, 12).map((entry) => {
        const Icon = kindIcon(entry.kind);
        return (
          <LensCard
            key={entry.id}
            href={
              onOpen
                ? undefined
                : `${workspacePath(workspace, `n/${entry.id}`)}${entry.block_id ? `#${entry.block_id}` : ""}`
            }
            onClick={onOpen ? () => onOpen(entry.id, entry.block_id) : undefined}
            icon={<Icon size={12} />}
            title={entry.title}
            meta={
              <span className="flex items-center gap-1.5">
                {entry.direction === "in" && (
                  <><ArrowDownRight size={9} /> references this</>
                )}
                {entry.direction === "out" && (
                  <><ArrowUpRight size={9} /> mentioned here</>
                )}
                {entry.direction === "both" && (
                  <><ArrowUpRight size={9} /> bidirectional</>
                )}
                {entry.block_id ? <span>#{entry.block_id}</span> : null}
              </span>
            }
          />
        );
      })}
    </ContextSection>
  );
}

/** Union of both lists keyed by node; a backlink that is also mentioned here becomes `both`. */
function mergeContextConnections(
  backlinks: Backlink[],
  forwardLinks: Backlink[] = [],
): ListEntry[] {
  const map = new Map<string, ListEntry>();
  for (const backlink of backlinks) {
    map.set(backlink.id, {
      id: backlink.id,
      title: backlink.title,
      kind: backlink.kind as NodeKind,
      direction: "in",
      block_id: backlink.block_id,
    });
  }
  for (const forward of forwardLinks) {
    const existing = map.get(forward.id);
    if (existing) {
      existing.direction = "both";
      existing.block_id ??= forward.block_id;
    } else {
      map.set(forward.id, {
        id: forward.id,
        title: forward.title,
        kind: forward.kind as NodeKind,
        direction: "out",
        block_id: forward.block_id,
      });
    }
  }
  return Array.from(map.values());
}

function ContextSection({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mono flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.08em] text-[var(--ink-mute)]">
        <span>{title}</span>
        {count !== undefined && (
          <Chip
            size="sm"
            variant="soft"
            className="h-4 min-h-0 rounded-full border-none bg-[var(--paper-3)] px-1.5 py-0 text-[9.5px] text-[var(--ink-mute)]"
          >
            <Chip.Label>{count}</Chip.Label>
          </Chip>
        )}
        <Separator className="flex-1" />
      </div>
      <div className="mt-2 flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

function LensCard({
  icon,
  title,
  meta,
  href,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  meta: React.ReactNode;
  href?: string;
  onClick?: () => void;
}) {
  const inner = (
    <div className="flex items-start gap-2 rounded-[9px] border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5">
      <span className="mt-0.5 text-[var(--ink-3)]">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] leading-snug text-[var(--ink)]">
          {title}
        </div>
        <div className="mono mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--ink-3)]">
          {meta}
        </div>
      </div>
    </div>
  );
  if (href) {
    return (
      <a href={href} className="block">
        {inner}
      </a>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className="block w-full text-left">
        {inner}
      </button>
    );
  }
  return <div>{inner}</div>;
}
