/**
 * The workspace overview at `/w/<org>/<ws>`: health figures, the 30-day
 * activity chart, what is due, what is aging and the latest decisions.
 *
 * Server Component. It derives everything from the node index the layout
 * already fetched for this request (`@/lib/overview`), plus one guarded call
 * for the review-inbox badge; there is no client state on this page.
 */
import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { Card, Separator } from "@heroui/react";
import { linkVariants } from "@heroui/styles";
import {
  EmptyState,
  EmptyStateDescription,
  EmptyStateHeader,
  EmptyStateTitle,
} from "@/components/ui/empty-state";
import { ItemCardGroup } from "@/components/ui/item-card";
import { gradientFor } from "@bcontext-dev/contract/workspace-gradients";
import { WorkspaceEmptyState } from "@/components/workspace-empty-state";
import { DashboardListRow, DashboardNodeChip } from "@/components/dashboard-list-row";
import { DashboardActivityChart } from "@/components/dashboard-activity-chart";
import {
  activitySeries,
  buildOverviewModel,
  daysUntilDue,
  type OverviewModel,
} from "@/lib/overview";
import { dayKey } from "@/lib/dates";
import { type KnowledgeNode } from "@bcontext-dev/contract/types";
import { nodeDeepLink, systemViewPath } from "@/lib/view-shell";
import { apiJson } from "@/web/api-client";
import { findWorkspace, listNodeSummaries } from "@/web/workspace";
import { type WorkspaceAddress } from "@/web/workspace-url";

const DAY_MS = 86_400_000;

export default async function WorkspaceHome({
  params,
}: {
  params: Promise<{ org: string; ws: string }>;
}) {
  const { org, ws } = await params;
  const address: WorkspaceAddress = { org, slug: ws };
  // The overview/chart/lists only read summary fields (kind, status, dates,
  // tags) — reuse the layout's request-scoped index instead of re-fetching
  // every node body. Zero additional API calls per render.
  const [workspace, nodes] = await Promise.all([findWorkspace(address), listNodeSummaries(address)]);
  if (!workspace || !nodes) notFound();
  const now = new Date();
  const today = dayKey(now);
  const overview = buildOverviewModel(nodes, now);

  if (nodes.length === 0) {
    return (
      <div className="mx-auto h-full max-w-4xl overflow-y-auto px-4 pb-8 pt-6 sm:px-10 sm:py-8">
        <WorkspaceEmptyState />
      </div>
    );
  }

  const pendingIngest = await getPendingIngestCount(workspace.id);
  const activity = activitySeries(nodes, now, 30);
  const accent = gradientFor({ slug: ws, metadata: workspace.metadata ?? null });

  return (
    <div className="scroll h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-4 pb-16 pt-4 sm:px-8 sm:pt-6">
        <ActivitySection ws={address} overview={overview} pendingIngest={pendingIngest} activity={activity} accent={accent} />

        <div className="mt-8 grid gap-5 lg:grid-cols-2">
          <OverviewSection
            title="Upcoming"
            description="Next 14 days"
            itemCount={overview.upcoming.length}
            emptyTitle="No deadlines in the next 14 days"
          >
            {interleave(
              overview.upcoming.map((node) => (
                <AgendaRow key={node.id} ws={address} node={node} today={today} />
              )),
            )}
          </OverviewSection>

          <OverviewSection
            title="Aging knowledge"
            description="Longest untouched"
            itemCount={overview.aging.length}
            emptyTitle="Nothing is aging"
            emptyDescription="Docs, ADRs and meetings show up here as they go untouched."
          >
            {interleave(
              overview.aging.map((node) => (
                <AgingRow key={node.id} ws={address} node={node} now={now} />
              )),
            )}
          </OverviewSection>
        </div>

        <RecentDecisionsRow ws={address} decisions={overview.decisions} />
      </div>
    </div>
  );
}

/**
 * The review inbox is a badge, not the page: a failure here (the stats route
 * answers 0 for the demo store, and anything else is a hiccup) must never
 * take the dashboard down with it.
 */
async function getPendingIngestCount(workspaceId: string): Promise<number> {
  try {
    const stats = await apiJson<{ candidates: Record<string, number> }>(
      `/api/ingest/stats?workspace_id=${encodeURIComponent(workspaceId)}`,
    );
    return stats.candidates.pending ?? 0;
  } catch {
    return 0;
  }
}

function ActivitySection({
  ws,
  overview,
  pendingIngest,
  activity,
  accent,
}: {
  ws: WorkspaceAddress;
  overview: OverviewModel;
  pendingIngest: number;
  activity: ReturnType<typeof activitySeries>;
  accent: { from: string; to: string };
}) {
  return (
    <section aria-label="Brain health">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
          <MiniStat label="Fresh knowledge" value={`${overview.totals.freshKnowledgePercent}%`} />
          <MiniStat
            label="Blocked"
            value={overview.totals.blocked}
            href={systemViewPath(ws, "tasks")}
          />
          <MiniStat
            label="Pending review"
            value={pendingIngest}
            href={systemViewPath(ws, "conflicts")}
          />
        </div>
        <div className="flex items-center gap-3 pb-1">
          <LegendDot color={accent.from} label="Created" />
          <LegendDot color={accent.to} label="Updated" />
        </div>
      </div>
      <Card className="rounded-2xl">
        <Card.Header className="pb-0">
          {/* The guide rings the title, not the card: the card is taller than
              the space a popover needs below or above it. */}
          <div data-tour="dashboard-activity" className="w-fit">
            <h2 className="text-[15px] font-medium text-foreground">Brain activity</h2>
            <p className="text-xs text-muted">Nodes created vs updated · last 30 days</p>
          </div>
        </Card.Header>
        <Card.Content>
          <DashboardActivityChart data={activity} colors={{ created: accent.from, updated: accent.to }} />
        </Card.Content>
      </Card>
    </section>
  );
}

function MiniStat({
  label,
  value,
  href,
}: {
  label: string;
  value: string | number;
  href?: Route;
}) {
  const content = (
    <>
      <span className="text-2xl font-semibold text-foreground">{value}</span>
      <span className="text-xs text-muted">{label}</span>
    </>
  );
  if (href) {
    return (
      <Link href={href} className="flex flex-col gap-0.5 transition-opacity hover:opacity-80">
        {content}
      </Link>
    );
  }
  return <div className="flex flex-col gap-0.5">{content}</div>;
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="size-2.5 rounded-full" style={{ backgroundColor: color }} />
      <span className="text-xs text-muted">{label}</span>
    </div>
  );
}

function OverviewSection({
  title,
  description,
  href,
  action,
  itemCount,
  emptyTitle,
  emptyDescription,
  children,
}: {
  title: string;
  description?: string;
  href?: Route;
  action?: string;
  itemCount: number;
  emptyTitle: string;
  emptyDescription?: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="min-w-0">
      <div className="mb-2 flex items-baseline justify-between gap-3 px-0.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="text-sm font-medium text-foreground">{title}</h2>
          {description ? <span className="truncate text-xs text-muted">{description}</span> : null}
        </div>
        {href && action ? (
          <Link href={href} className={`${linkVariants().base()} shrink-0 text-sm`}>
            {action}
            <ArrowRight className="ml-1 size-3" />
          </Link>
        ) : null}
      </div>
      {itemCount === 0 ? (
        <EmptyState size="sm" className="rounded-2xl border border-dashed border-border">
          <EmptyStateHeader>
            <EmptyStateTitle className="text-sm">{emptyTitle}</EmptyStateTitle>
            {emptyDescription ? (
              <EmptyStateDescription>{emptyDescription}</EmptyStateDescription>
            ) : null}
          </EmptyStateHeader>
        </EmptyState>
      ) : (
        <ItemCardGroup className="overflow-hidden">{children}</ItemCardGroup>
      )}
    </section>
  );
}

/** Inserts a Separator between each item so ItemCardGroup renders divided rows. */
function interleave(items: ReactNode[]): ReactNode[] {
  return items.flatMap((item, index) =>
    index === 0 ? [item] : [<Separator key={`sep-${index}`} />, item],
  );
}

function AgendaRow({ ws, node, today }: { ws: WorkspaceAddress; node: KnowledgeNode; today: string }) {
  const days = daysUntilDue(node, today);
  if (days === null) return null;
  return (
    <DashboardListRow
      href={nodeDeepLink(ws, node.id)}
      nodeId={node.id}
      kind={node.kind}
      title={node.title}
      chip={{ label: relativeDueLabel(days), color: days <= 0 ? "warning" : "default" }}
    />
  );
}

function AgingRow({ ws, node, now }: { ws: WorkspaceAddress; node: KnowledgeNode; now: Date }) {
  const daysOld = Math.max(0, Math.round((now.getTime() - Date.parse(node.updated_at)) / DAY_MS));
  return (
    <DashboardListRow
      href={nodeDeepLink(ws, node.id)}
      nodeId={node.id}
      kind={node.kind}
      title={node.title}
      chip={{ label: `${daysOld}d`, color: daysOld > 60 ? "danger" : "default" }}
    />
  );
}

function RecentDecisionsRow({ ws, decisions }: { ws: WorkspaceAddress; decisions: KnowledgeNode[] }) {
  if (decisions.length === 0) return null;
  return (
    <section aria-label="Recent decisions" className="mt-8">
      {/* No "View all": the Decisions system view was retired on 2026-09-08.
          Decisions are still a node kind — Browse and the Brain graph reach
          them, and each chip below deep-links to the node itself. */}
      <div className="mb-2 px-0.5">
        <h2 className="text-sm font-medium text-foreground">Recent decisions</h2>
      </div>
      <div className="flex flex-wrap gap-2">
        {decisions.slice(0, 5).map((node) => (
          <DashboardNodeChip key={node.id} href={nodeDeepLink(ws, node.id)} nodeId={node.id} title={node.title} />
        ))}
      </div>
    </section>
  );
}

function relativeDueLabel(days: number): string {
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `In ${days} days`;
}
