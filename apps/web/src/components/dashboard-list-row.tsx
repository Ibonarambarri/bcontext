"use client";

import type { Route } from "next";
import { Chip } from "@heroui/react";
import { ItemCard } from "@/components/ui/item-card";
import { nodeKindIcon } from "./node-kind-icon";
import { NodeLink, useOpenNodeInPanel } from "./node-open-link";
import type { NodeKind } from "@bcontext-dev/contract/types";

/**
 * Rows and chips of the workspace overview (`w/[org]/[ws]/page.tsx`, a
 * Server Component — this is its one client island for opening nodes).
 *
 * A node on the dashboard opens where every other node in the workspace
 * opens: the floating panel over the current surface, half of it by default
 * (`useOpenNodeInPanel`). No navigation to `/n/<id>` and no hover preview:
 * a popup you have to wait for, then aim at, only does what clicking the row
 * already does. `href` stays on the anchor for middle-click and crawlers.
 */
export interface DashboardListRowProps {
  href: Route;
  nodeId: string;
  kind: NodeKind;
  title: string;
  /** Small trailing chip (e.g. "Tomorrow", "43d"). */
  chip?: { label: string; color?: "default" | "warning" | "danger" | "accent" };
}

/** Minimal dashboard list row: icon + single-line truncated title + chip. */
export function DashboardListRow({ href, nodeId, kind, title, chip }: DashboardListRowProps) {
  const Icon = nodeKindIcon(kind);
  const open = useOpenNodeInPanel(nodeId);
  return (
    <ItemCard<"a">
      className="cursor-pointer transition-colors hover:bg-default/30"
      render={(props) => <a {...props} href={href} onClick={open} />}
    >
      <Icon className="size-4 shrink-0 text-muted" />
      <ItemCard.Content className="min-w-0">
        <ItemCard.Title className="block max-w-full truncate whitespace-nowrap">{title}</ItemCard.Title>
      </ItemCard.Content>
      {chip ? (
        <ItemCard.Action>
          <Chip size="sm" color={chip.color ?? "default"} variant="soft">
            <Chip.Label>{chip.label}</Chip.Label>
          </Chip>
        </ItemCard.Action>
      ) : null}
    </ItemCard>
  );
}

/** The same gesture, as a pill — the dashboard's recent-decisions row. */
export function DashboardNodeChip({ href, nodeId, title }: { href: Route; nodeId: string; title: string }) {
  return (
    <NodeLink
      href={href}
      nodeId={nodeId}
      className="rounded-full border border-border bg-default/20 px-3 py-1 text-xs text-foreground transition-colors hover:bg-default/40"
    >
      {title}
    </NodeLink>
  );
}
