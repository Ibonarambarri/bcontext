/**
 * Standardized skeleton system — one family of loading placeholders shared
 * by every surface of the app. `src/app/dev/skeletons/page.tsx` renders
 * them all side by side for review.
 *
 * Rules:
 * - Skeletons ALWAYS mirror the real layout that will replace them: same
 *   containers, same paddings, same row/card anatomy — no layout shift.
 * - Built on the HeroUI `Skeleton` primitive (theme-aware surface tokens,
 *   subtle shimmer in light and dark).
 * - Pages and sections never show spinners; spinners remain legitimate only
 *   as in-flight button/badge states.
 *
 * Components are presentational-only (no hooks, no client requirement) so
 * both Server Components (`loading.tsx`) and client views can render them.
 */
import { Card, Skeleton } from "@heroui/react";
import { cn } from "@bcontext-dev/contract/utils";

/* ────────────────────────────────────────────────────────────────────────
 * GridSkeleton — card grids (Agents, Tools, Integrations, Workspaces).
 * Card anatomy mirrors AgentCard / ProviderCard / WorkspaceCard: icon tile,
 * title + subtitle, trailing chip, one description line, bordered footer.
 * ──────────────────────────────────────────────────────────────────────── */

export function GridSkeleton({
  cards = 6,
  minHeightClassName = "min-h-[150px]",
  className,
  label = "Loading cards",
}: {
  cards?: number;
  /** min-h of each card: agents use 150px, tools/integrations 170px+. */
  minHeightClassName?: string;
  className?: string;
  label?: string;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      className={cn("mt-5 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3", className)}
    >
      {Array.from({ length: cards }).map((_, index) => (
        <GridCardSkeleton key={index} minHeightClassName={minHeightClassName} />
      ))}
    </div>
  );
}

function GridCardSkeleton({
  minHeightClassName = "min-h-[150px]",
}: {
  minHeightClassName?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "flex flex-col rounded-[12px] border border-[var(--line)] bg-[var(--paper)] p-4",
        minHeightClassName,
      )}
    >
      <div className="flex items-start gap-3">
        <Skeleton className="h-10 w-10 shrink-0 rounded-[10px]" />
        <div className="min-w-0 flex-1 space-y-2 pt-0.5">
          <Skeleton className="h-3.5 w-3/5 rounded" />
          <Skeleton className="h-3 w-2/5 rounded" />
        </div>
        <Skeleton className="h-5 w-16 shrink-0 rounded-full" />
      </div>
      <Skeleton className="mt-3.5 h-3 w-4/5 rounded" />
      <div className="mt-auto flex items-center gap-2 border-t border-[var(--line)] pt-3">
        <Skeleton className="h-5 w-16 rounded-full" />
        <Skeleton className="ml-auto h-3 w-24 rounded" />
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * ListSkeleton — icon + line + meta rows (Activity, saved list views,
 * members, tags, tokens, requests…).
 * ──────────────────────────────────────────────────────────────────────── */

function ListRowSkeleton({
  avatar = "icon",
  className,
}: {
  /** "icon" = small square/round glyph; "none" = text-only row. */
  avatar?: "icon" | "avatar" | "none";
  className?: string;
}) {
  return (
    <div aria-hidden="true" className={cn("flex items-center gap-3 px-3 py-3", className)}>
      {avatar === "icon" ? <Skeleton className="h-4 w-4 shrink-0 rounded" /> : null}
      {avatar === "avatar" ? <Skeleton className="h-7 w-7 shrink-0 rounded-full" /> : null}
      <div className="min-w-0 flex-1 space-y-1.5">
        <Skeleton className="h-3 w-1/2 rounded" />
        <Skeleton className="h-2.5 w-1/3 rounded" />
      </div>
      <Skeleton className="h-5 w-12 shrink-0 rounded-full" />
      <Skeleton className="h-3 w-10 shrink-0 rounded" />
    </div>
  );
}

export function ListSkeleton({
  rows = 6,
  container = "card",
  avatar = "icon",
  className,
  label = "Loading list",
}: {
  rows?: number;
  /**
   * "card" = bordered rounded container with dividers (Activity feed);
   * "plain" = bare stacked rows (modal bodies, side panels).
   */
  container?: "card" | "plain";
  avatar?: "icon" | "avatar" | "none";
  className?: string;
  label?: string;
}) {
  const items = Array.from({ length: rows }).map((_, index) => (
    <ListRowSkeleton key={index} avatar={avatar} />
  ));
  if (container === "plain") {
    return (
      <div role="status" aria-label={label} className={cn("flex flex-col gap-1", className)}>
        {items}
      </div>
    );
  }
  return (
    <div
      role="status"
      aria-label={label}
      className={cn(
        "divide-y divide-[var(--line)] rounded-md border border-[var(--line)] bg-[var(--paper)]",
        className,
      )}
    >
      {items}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * IngestQueueSkeleton — what the Integrations hub (integrations-hub.tsx)
 * shows while installs load: a heading row with a trailing button, a box,
 * then a second heading and two collapsed rows (chevron only). Its anatomy
 * is that of the former processing queue, close enough to the hub's toolbar
 * + rows to hold the space.
 * ──────────────────────────────────────────────────────────────────────── */

export function IngestQueueSkeleton() {
  return (
    <div role="status" aria-label="Loading processing queue" className="mt-2">
      {/* NEXO processing: heading left, Configure button right, then the box. */}
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-3.5 w-32 rounded" />
        <Skeleton className="h-8 w-28 shrink-0 rounded-lg" />
      </div>
      <div aria-hidden="true" className="mt-3 flex min-h-[84px] items-center justify-center rounded-[14px] border border-dashed border-[var(--line)] bg-[var(--paper-2)] px-4 py-5">
        <Skeleton className="h-3 w-72 max-w-[70%] rounded" />
      </div>

      {/* Incoming queue: heading + stacks. */}
      <div className="mt-7 space-y-1.5">
        <Skeleton className="h-3.5 w-28 rounded" />
        <Skeleton className="h-2.5 w-64 rounded" />
      </div>
      <div className="mt-3 flex flex-col gap-3">
        {Array.from({ length: 2 }).map((_, index) => (
          <div key={index} aria-hidden="true" className="flex items-center gap-3 rounded-[12px] border border-[var(--line)] bg-[var(--paper-2)] px-4 py-2.5">
            <Skeleton className="h-8 w-8 shrink-0 rounded-[8px]" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex items-center gap-2">
                <Skeleton className="h-3 w-40 rounded" />
                <Skeleton className="h-4 w-7 rounded-full" />
              </div>
              <Skeleton className="h-2.5 w-52 rounded" />
            </div>
            <Skeleton className="h-7 w-7 shrink-0 rounded-lg" />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * DashboardSkeleton — traced from the real workspace overview
 * (src/app/w/[org]/[ws]/page.tsx): mini-stats + legend, Brain-activity Card with
 * a 260px chart, two OverviewSection lists, recent-decisions chip row.
 * ──────────────────────────────────────────────────────────────────────── */

export function DashboardSkeleton() {
  return (
    <div role="status" aria-label="Loading workspace overview" className="scroll h-full overflow-y-auto">
      <div aria-hidden="true" className="mx-auto max-w-6xl px-4 pb-16 pt-4 sm:px-8 sm:pt-6">
        {/* Brain health: 3 MiniStats left, chart legend right. */}
        <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="flex flex-col gap-1.5">
                <Skeleton className="h-7 w-12 rounded" />
                <Skeleton className="h-3 w-20 rounded" />
              </div>
            ))}
          </div>
          <div className="flex items-center gap-3 pb-1">
            {Array.from({ length: 2 }).map((_, index) => (
              <div key={index} className="flex items-center gap-1.5">
                <Skeleton className="size-2.5 rounded-full" />
                <Skeleton className="h-3 w-12 rounded" />
              </div>
            ))}
          </div>
        </div>

        {/* Brain activity card: header + 260px area chart. */}
        <Card className="rounded-2xl">
          <Card.Header className="pb-0">
            <div className="space-y-1.5">
              <Skeleton className="h-4 w-28 rounded" />
              <Skeleton className="h-3 w-56 rounded" />
            </div>
          </Card.Header>
          <Card.Content>
            <Skeleton className="h-[260px] w-full rounded-lg" />
          </Card.Content>
        </Card>

        {/* Upcoming / Aging knowledge — two ItemCardGroup lists. */}
        <div className="mt-8 grid gap-5 lg:grid-cols-2">
          {Array.from({ length: 2 }).map((_, section) => (
            <section key={section} className="min-w-0">
              <div className="mb-2 flex items-baseline gap-2 px-0.5">
                <Skeleton className="h-4 w-24 rounded" />
                <Skeleton className="h-3 w-16 rounded" />
              </div>
              <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border">
                {Array.from({ length: 5 }).map((_, row) => (
                  <div key={row} className="flex items-center gap-3 px-4 py-3">
                    <Skeleton className="size-4 shrink-0 rounded" />
                    <Skeleton className={cn("h-3.5 rounded", row % 2 === 0 ? "w-3/5" : "w-2/5")} />
                    <Skeleton className="ml-auto h-5 w-14 shrink-0 rounded-full" />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>

        {/* Recent decisions chip row. */}
        <section className="mt-8">
          <div className="mb-2 flex items-baseline justify-between gap-3 px-0.5">
            <Skeleton className="h-4 w-32 rounded" />
            <Skeleton className="h-3 w-14 rounded" />
          </div>
          <div className="flex flex-wrap gap-2">
            {[28, 40, 24, 36, 30].map((width, index) => (
              <Skeleton key={index} className="h-7 rounded-full" style={{ width: `${width * 4}px` }} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * ViewSkeleton — saved list/table view canvas traced from SavedListView:
 * meta line + Filter button ghost, then the rounded card of rows
 * (kind glyph · title · tag chips · time).
 * ──────────────────────────────────────────────────────────────────────── */

export function ViewSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading view" className="scroll h-full overflow-y-auto">
      <div aria-hidden="true" className="mx-auto max-w-5xl px-4 pb-16 pt-4 sm:px-10 sm:pt-5">
        <div className="flex items-end gap-3">
          <Skeleton className="h-3 w-20 rounded" />
          {/* Ghost for the Filter button so the header doesn't pop. */}
          <Skeleton className="ml-auto h-8 w-20 shrink-0 rounded-lg" />
        </div>
        <div className="mt-4 divide-y divide-[var(--line)] overflow-hidden rounded-[14px] border border-[var(--line)] bg-[var(--paper)]">
          {Array.from({ length: rows }).map((_, index) => (
            <div key={index} className="flex items-center gap-3 px-3 py-3">
              <Skeleton className="h-4 w-4 shrink-0 rounded" />
              <Skeleton
                className={cn("h-3.5 rounded", index % 3 === 0 ? "w-2/3" : index % 3 === 1 ? "w-1/2" : "w-3/5")}
              />
              <Skeleton className="ml-auto hidden h-4 w-14 shrink-0 rounded-full sm:block" />
              <Skeleton className="h-2.5 w-12 shrink-0 rounded" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * BoardSkeleton — kanban columns while a board view resolves.
 * ──────────────────────────────────────────────────────────────────────── */

export function BoardSkeleton({
  columns = 4,
  fluid = false,
  className,
}: {
  columns?: number;
  /** Columns grow with the container instead of keeping the fixed kanban width. */
  fluid?: boolean;
  className?: string;
}) {
  // Deterministic (SSR-safe) pseudo-random card distribution per column.
  const CARDS = [3, 2, 4, 1, 3, 2];
  return (
    <div
      role="status"
      aria-label="Loading board"
      className={cn("mt-4 flex items-start gap-3 overflow-hidden pb-2", className)}
    >
      {Array.from({ length: columns }).map((_, column) => (
        <div
          key={column}
          aria-hidden="true"
          className={cn(
            "flex flex-col gap-2 rounded-xl bg-[var(--paper-2)] p-2",
            fluid ? "min-w-[280px] flex-1" : "w-[280px] shrink-0",
          )}
        >
          <div className="flex items-center gap-2 px-1.5 py-1.5">
            <Skeleton className="size-2 rounded-full" />
            <Skeleton className="h-3.5 w-20 rounded" />
            <Skeleton className="ml-auto h-3.5 w-5 rounded" />
          </div>
          {Array.from({ length: CARDS[column % CARDS.length] ?? 2 }).map((_, card) => (
            <div
              key={card}
              className="space-y-2 rounded-lg border border-[var(--line)] bg-[var(--paper)] p-3"
            >
              <Skeleton className={cn("h-3.5 rounded", card % 2 === 0 ? "w-4/5" : "w-3/5")} />
              <div className="flex items-center gap-1.5">
                <Skeleton className="h-4 w-12 rounded-full" />
                <Skeleton className="h-4 w-9 rounded-full" />
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * GraphSkeleton — canvas placeholder for GraphRenderer's stage: toolbar
 * cluster top, legend bottom-left, and a few ghost nodes scattered where the
 * graph will settle.
 * ──────────────────────────────────────────────────────────────────────── */

export function GraphSkeleton({ compact = false }: { compact?: boolean }) {
  const NODES = [
    { top: "38%", left: "46%", size: 22 },
    { top: "26%", left: "60%", size: 14 },
    { top: "58%", left: "62%", size: 16 },
    { top: "30%", left: "32%", size: 12 },
    { top: "62%", left: "36%", size: 14 },
    { top: "48%", left: "72%", size: 10 },
    { top: "70%", left: "52%", size: 10 },
  ];
  return (
    <div
      role="status"
      aria-label="Loading graph"
      className={cn(
        "relative h-full min-h-0 overflow-hidden bg-[var(--paper-2)]",
        compact
          ? "min-h-[150px] rounded-lg border border-[var(--line)]"
          : "bg-[radial-gradient(circle_at_center,color-mix(in_srgb,var(--line)_38%,transparent)_0.7px,transparent_0.8px)] bg-[length:18px_18px]",
      )}
    >
      {!compact ? (
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-3">
          <div className="rounded-xl border border-[var(--line)] bg-[var(--paper)]/92 px-3 py-2 shadow-sm backdrop-blur-md">
            <Skeleton className="h-2.5 w-40 rounded" />
            <div className="mt-2 flex items-center gap-1">
              <Skeleton className="h-6 w-14 rounded-full" />
              <Skeleton className="h-6 w-12 rounded-full" />
              <Skeleton className="h-6 w-14 rounded-full" />
            </div>
          </div>
          <div className="flex items-center gap-1 rounded-xl border border-[var(--line)] bg-[var(--paper)]/92 p-1.5 shadow-sm backdrop-blur-md">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="size-6 rounded-lg" />
            ))}
          </div>
        </div>
      ) : null}

      {/* Ghost nodes where the layout will settle. */}
      <div aria-hidden="true" className="absolute inset-0">
        {NODES.map((node, index) => (
          <Skeleton
            key={index}
            className="absolute rounded-full"
            style={{ top: node.top, left: node.left, width: node.size, height: node.size }}
          />
        ))}
      </div>

      {!compact ? (
        <div aria-hidden="true" className="absolute bottom-3 left-3 flex items-center gap-3 rounded-lg border border-[var(--line)] bg-[var(--paper)]/88 px-2.5 py-1.5 backdrop-blur-md">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="flex items-center gap-1">
              <Skeleton className="size-2 rounded-full" />
              <Skeleton className="h-2 w-8 rounded" />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * DetailSkeleton — node inspector / drawer body (title, property grid,
 * content blocks). Header stays real (close button keeps working).
 * ──────────────────────────────────────────────────────────────────────── */

export function DetailSkeleton({ className }: { className?: string }) {
  return (
    <div
      role="status"
      aria-label="Loading node"
      className={cn("flex-1 space-y-4 overflow-hidden px-4 py-4", className)}
    >
      <Skeleton aria-hidden="true" className="h-6 w-3/4 rounded-md" />
      <div aria-hidden="true" className="grid grid-cols-2 gap-2">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-10 rounded-md" />
        ))}
      </div>
      <Skeleton aria-hidden="true" className="h-16 rounded-md" />
      <Skeleton aria-hidden="true" className="h-3 w-2/5 rounded-md" />
      <Skeleton aria-hidden="true" className="h-20 rounded-md" />
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * PanelBodySkeleton — the body area of the floating node panel while an
 * async body chunk (the editor, a meeting view) loads. The panel's header
 * and identity strip are already real above it, so this is only prose
 * lines under a toolbar-shaped bar.
 * ──────────────────────────────────────────────────────────────────────── */

export function PanelBodySkeleton({ className }: { className?: string }) {
  const LINES = ["w-full", "w-11/12", "w-4/5", "w-full", "w-2/3"];
  return (
    <div role="status" aria-label="Loading content" className={cn("space-y-3", className)}>
      <Skeleton aria-hidden="true" className="h-8 w-full rounded-lg" />
      {LINES.map((width, index) => (
        <Skeleton key={index} aria-hidden="true" className={cn("h-3.5 rounded", width)} />
      ))}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * NodePageSkeleton — full node page (editor layout: --edit-max container,
 * title, tag row, paragraph lines). Used by the route's loading.tsx and by
 * the lazy editor chunks while they hydrate.
 * ──────────────────────────────────────────────────────────────────────── */

export function NodePageSkeleton() {
  const LINES = ["w-full", "w-11/12", "w-full", "w-9/12", "w-10/12", "w-2/3", "w-11/12", "w-1/2"];
  return (
    <div role="status" aria-label="Loading node" className="scroll relative h-full overflow-y-auto bg-[var(--paper)]">
      <div
        aria-hidden="true"
        className="mx-auto"
        style={{
          maxWidth: "var(--edit-max, 920px)",
          paddingInline: "var(--editor-px)",
          paddingBlock: "var(--editor-py)",
          paddingBottom: "120px",
        }}
      >
        <div className="mb-6">
          <Skeleton className="h-8 w-2/3 rounded-md" />
          <div className="mt-3 flex items-center gap-1.5">
            <Skeleton className="h-2.5 w-8 rounded" />
            <Skeleton className="h-6 w-16 rounded-md" />
            <Skeleton className="h-6 w-20 rounded-md" />
          </div>
        </div>
        <div className="space-y-3.5">
          {LINES.map((width, index) => (
            <Skeleton key={index} className={cn("h-4 rounded", width)} />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * WorkspacesHubSkeleton — /workspaces route (top nav, header row, an
 * organization section header and its card grid), traced from WorkspacesView.
 * ──────────────────────────────────────────────────────────────────────── */

export function WorkspacesHubSkeleton() {
  return (
    <div role="status" aria-label="Loading workspaces" className="flex h-dvh w-full flex-col overflow-hidden bg-[var(--paper)]">
      <div aria-hidden="true" className="flex h-[52px] shrink-0 items-center gap-3.5 border-b border-[var(--line)] bg-[var(--paper)] px-5 max-sm:px-3.5">
        <span className="text-[16px] font-semibold tracking-[-.015em] text-[var(--ink)]">Bcontext</span>
        <span className="flex-1" />
        <Skeleton className="size-7 rounded-full" />
      </div>
      <div aria-hidden="true" className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1180px] px-7 pb-16 pt-7 max-sm:px-4 max-sm:pt-5">
          {/* Header row */}
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-2">
              <Skeleton className="h-7 w-44 rounded" />
              <Skeleton className="h-3 w-56 rounded" />
            </div>
            <span className="ml-auto" />
            <Skeleton className="h-8 w-20 rounded-lg" />
            <Skeleton className="h-8 w-36 rounded-lg" />
          </div>
          {/* Organization section header */}
          <div className="mt-5 flex items-center gap-2.5">
            <Skeleton className="size-3.5 rounded" />
            <Skeleton className="h-4 w-40 rounded" />
            <Skeleton className="h-3 w-24 rounded" />
          </div>
          <GridSkeleton cards={6} minHeightClassName="min-h-[150px]" />
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * RoadmapSkeleton — goal rows × horizon columns while a roadmap resolves.
 * ──────────────────────────────────────────────────────────────────────── */

export function RoadmapSkeleton({ rows = 4, className }: { rows?: number; className?: string }) {
  // Deterministic (SSR-safe) card counts per cell, so the frame is stable.
  const CELLS = [2, 1, 1, 1, 2, 0, 0, 1, 2, 1, 0, 1];
  return (
    <div role="status" aria-label="Loading roadmap" className={cn("mt-4 overflow-hidden", className)}>
      <div className="mb-3 flex items-center justify-between">
        <Skeleton className="h-4 w-56 rounded" />
        <Skeleton className="h-6 w-20 rounded-md" />
      </div>
      <div aria-hidden="true" className="grid gap-0" style={{ gridTemplateColumns: "240px repeat(3, minmax(200px, 1fr))" }}>
        <div className="border-b border-[var(--line)] pb-2" />
        {[0, 1, 2].map((column) => (
          <div key={column} className="border-b border-[var(--line)] px-2 pb-2">
            <Skeleton className="h-3 w-12 rounded" />
          </div>
        ))}
        {Array.from({ length: rows }).map((_, row) => (
          <div key={row} className="contents">
            <div className="space-y-1.5 border-b border-[var(--line)] px-2 py-3">
              <Skeleton className={cn("h-3.5 rounded", row % 2 === 0 ? "w-4/5" : "w-3/5")} />
              <Skeleton className="h-3 w-24 rounded" />
            </div>
            {[0, 1, 2].map((column) => (
              <div key={column} className="space-y-1.5 border-b border-[var(--line)] p-2">
                {Array.from({ length: CELLS[(row * 3 + column) % CELLS.length] ?? 0 }).map((_, card) => (
                  <div key={card} className="space-y-2 rounded-lg border border-[var(--line)] bg-[var(--paper)] p-2.5">
                    <Skeleton className={cn("h-3.5 rounded", card % 2 === 0 ? "w-4/5" : "w-3/5")} />
                    <Skeleton className="h-3 w-16 rounded" />
                  </div>
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
