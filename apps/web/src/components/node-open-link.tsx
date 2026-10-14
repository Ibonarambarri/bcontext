"use client";

/**
 * The one gesture for "open this node" outside the surfaces that own their
 * own selection (board, list, graph, browse, changes).
 *
 * A node opens in the floating panel over whatever is on screen — half of it
 * by default, expandable — so following a reference never costs you the view
 * you were reading it from. It stays a real anchor, so ⌘/ctrl/shift/middle
 * click still opens `/n/<id>` as its own page: the escape hatch belongs where
 * the browser already put it, not behind a hover popup with an Open button.
 */

import type { Route } from "next";
import { useWorkspace } from "./workspace-context";

export function useOpenNodeInPanel(nodeId: string, blockId?: string | null) {
  const { selectNode } = useWorkspace();
  return (event: React.MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    selectNode(nodeId, { blockId: blockId ?? null });
  };
}

export function NodeLink({
  href,
  nodeId,
  blockId,
  className,
  children,
}: {
  href: Route | string;
  nodeId: string;
  blockId?: string | null;
  className?: string;
  children: React.ReactNode;
}) {
  const open = useOpenNodeInPanel(nodeId, blockId);
  return (
    <a href={href} onClick={open} className={className}>
      {children}
    </a>
  );
}
