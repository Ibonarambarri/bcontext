"use client";

/**
 * The roadmap for `roadmap`-renderer saved views, mounted by
 * `saved-roadmap-view.tsx` with the model the API computed
 * (`@bcontext-dev/contract/roadmap/model`): goals as rows in tree order,
 * now / next / later as columns, the tasks and bugs that contribute to each
 * goal as cards. This file only draws it — which row a card is in and which
 * column it earns are decided in the contract, so an agent reading
 * `views(op=resolve)` sees exactly this grid.
 *
 * It is the place to LOOK, not to work: no drag between columns (moving a
 * card is a status, priority or edge change, and the board is where those
 * happen), no create. A click opens the node in the floating panel, the
 * goal included. Done cards stay off the live columns behind one switch,
 * so the grid reads as what is ahead.
 */

import { useState } from "react";
import { AlertTriangle, Bug, CalendarDays, CheckSquare, ListChecks, Milestone, Target } from "lucide-react";
import { Button, Chip, Tooltip } from "@heroui/react";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@bcontext-dev/contract/utils";
import {
  ROADMAP_UNASSIGNED_LANE,
  type RoadmapCard,
  type RoadmapGoal,
  type RoadmapLane,
  type RoadmapModel,
} from "@bcontext-dev/contract/roadmap/model";
import { GOAL_STATUS_LABELS, STATUS_LABELS, type GoalStatus, type TaskStatus } from "@bcontext-dev/contract/types";
import { useWorkspace } from "@/components/workspace-context";
import { formatGoalProgress, GOAL_STATUS_DOT } from "@/lib/goals/presentation";

/** The same hues the board's column indicators use, so a status reads the same in both places. */
const STATUS_DOT: Record<string, string> = {
  todo: "oklch(70% 0.02 80)",
  in_progress: "var(--accent)",
  blocked: "var(--warn)",
  done: "oklch(70% 0 0)",
  review: "oklch(65% 0.08 250)",
  backlog: "var(--ink-mute)",
};

export function RoadmapRenderer({ model }: { model: RoadmapModel }) {
  const { inspectedNodeId, selectNode } = useWorkspace();
  const [showDone, setShowDone] = useState(false);
  const doneCount = model.lanes.reduce((sum, lane) => sum + lane.done.length, 0);
  const columns = showDone ? [...model.columns, { id: "done" as const, label: "Done" }] : model.columns;

  if (model.lanes.length === 0) {
    return (
      <EmptyState className="mt-6 min-h-[320px] rounded-2xl border border-dashed border-[var(--line)] bg-[var(--paper-2)] px-6 py-12">
        <EmptyState.Header>
          <EmptyState.Media variant="icon">
            <Milestone size={18} />
          </EmptyState.Media>
          <EmptyState.Title className="text-[16px] text-[var(--ink)]">Nothing on the roadmap yet</EmptyState.Title>
          <EmptyState.Description className="max-w-[460px]">
            Rows are the workspace&rsquo;s goals and cards are the tasks that contribute to them. Create a goal, then link
            work to it with a <span className="mono">contributes_to</span> relation, and it appears here.
          </EmptyState.Description>
        </EmptyState.Header>
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-renderer="roadmap">
      <RoadmapHeader
        model={model}
        doneCount={doneCount}
        showDone={showDone}
        onToggleDone={() => setShowDone((value) => !value)}
        selectNode={selectNode}
      />

      <div className="overflow-x-auto">
        <div
          role="table"
          aria-label="Roadmap"
          className="min-w-[860px]"
          style={{
            display: "grid",
            gridTemplateColumns: `minmax(220px, 260px) repeat(${columns.length}, minmax(200px, 1fr))`,
          }}
        >
          {/* Column headings: mono, uppercase, quiet — the same voice as a board column title. */}
          <div role="row" className="contents">
            <div role="columnheader" className="sticky top-0 border-b border-[var(--line)] px-2 pb-2 pt-1" />
            {columns.map((column) => (
              <div
                key={column.id}
                role="columnheader"
                className="mono border-b border-[var(--line)] px-2 pb-2 pt-1 text-[10.5px] uppercase tracking-wide text-[var(--ink-3)]"
              >
                {column.label}
                <span className="ml-1.5 text-[var(--ink-mute)]">
                  {model.lanes.reduce((sum, lane) => sum + (column.id === "done" ? lane.done.length : lane.cells[column.id].length), 0)}
                </span>
              </div>
            ))}
          </div>

          {model.lanes.map((lane) => (
            <div key={lane.id} role="row" className="contents">
              <LaneHeader lane={lane} selected={inspectedNodeId === lane.id} selectNode={selectNode} />
              {columns.map((column) => {
                const cards = column.id === "done" ? lane.done : lane.cells[column.id];
                return (
                  <div
                    key={column.id}
                    role="cell"
                    className={cn(
                      "flex flex-col gap-1.5 border-b border-[var(--line)] p-2 align-top",
                      column.id === "now" && "bg-[var(--paper-2)]/40",
                    )}
                  >
                    {cards.map((card) => (
                      <RoadmapCardItem key={card.id} card={card} selected={inspectedNodeId === card.id} selectNode={selectNode} />
                    ))}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function RoadmapHeader({
  model,
  doneCount,
  showDone,
  onToggleDone,
  selectNode,
}: {
  model: RoadmapModel;
  doneCount: number;
  showDone: boolean;
  onToggleDone: () => void;
  selectNode: (id: string) => void;
}) {
  const northStar = model.north_star;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      {northStar ? (
        <button
          type="button"
          onClick={() => selectNode(northStar.id)}
          className="flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-[var(--paper-2)]"
          aria-label={`Open North Star: ${northStar.title}`}
        >
          <Target size={13} className="shrink-0 text-[var(--ink-3)]" />
          <span className="truncate text-[13px] text-[var(--ink)]">{northStar.title}</span>
          <span className="mono shrink-0 text-[10.5px] text-[var(--ink-3)]">North Star</span>
        </button>
      ) : (
        <p className="m-0 text-[12.5px] text-[var(--ink-3)]">Goals as rows, the work that pushes them as cards.</p>
      )}
      <div className="flex items-center gap-2">
        <span className="mono text-[10.5px] text-[var(--ink-3)]">
          {model.lanes.length} {model.lanes.length === 1 ? "row" : "rows"} · done window {model.done_window_days}d
        </span>
        <Button
          size="sm"
          variant={showDone ? "secondary" : "ghost"}
          onPress={onToggleDone}
          isDisabled={doneCount === 0}
          className="gap-1.5 text-[11.5px]"
          aria-pressed={showDone}
        >
          <CheckSquare size={12} />
          Done · {doneCount}
        </Button>
      </div>
    </div>
  );
}

function LaneHeader({ lane, selected, selectNode }: { lane: RoadmapLane; selected: boolean; selectNode: (id: string) => void }) {
  const goal = lane.goal;
  if (!goal || lane.id === ROADMAP_UNASSIGNED_LANE) {
    return (
      <div role="rowheader" className="border-b border-[var(--line)] px-2 py-2.5">
        <div className="text-[12.5px] italic text-[var(--ink-3)]">No objective</div>
        <div className="mono mt-1 text-[10.5px] text-[var(--ink-mute)]">
          {lane.total} {lane.total === 1 ? "item" : "items"} without <span className="text-[var(--ink-3)]">contributes_to</span>
        </div>
      </div>
    );
  }
  return (
    <div
      role="rowheader"
      className="border-b border-[var(--line)] py-2.5 pr-2"
      style={{ paddingLeft: `${8 + lane.depth * 14}px` }}
    >
      <button
        type="button"
        onClick={() => selectNode(goal.id)}
        aria-pressed={selected}
        data-node-id={goal.id}
        className={cn(
          "group flex w-full flex-col gap-1 rounded-md px-1 py-0.5 text-left hover:bg-[var(--paper-2)]",
          selected && "bg-[var(--paper-2)]",
        )}
      >
        <span className="flex items-start gap-1.5">
          <GoalDot status={goal.status} />
          <span className={cn("line-clamp-2 text-[12.5px] text-[var(--ink)]", lane.depth > 0 && "text-[12px]")}>{goal.title}</span>
        </span>
        <span className="mono flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-[14px] text-[10px] text-[var(--ink-3)]">
          {goal.cycle ? <span>{goal.cycle}</span> : goal.end ? <span>until {goal.end}</span> : null}
          <span className={cn(goal.progress !== null && goal.progress >= 1 && "text-[var(--ink)]")}>{formatGoalProgress(goal.progress)}</span>
          {!goal.active ? <span className="text-[var(--ink-mute)]">closed</span> : null}
        </span>
        {goal.progress !== null ? (
          <span className="ml-[14px] mt-0.5 block h-[3px] w-full max-w-[120px] overflow-hidden rounded-full bg-[var(--line)]" aria-hidden="true">
            <span className="block h-full rounded-full bg-[var(--ink-3)]" style={{ width: `${Math.round(goal.progress * 100)}%` }} />
          </span>
        ) : null}
      </button>
    </div>
  );
}

function GoalDot({ status }: { status: RoadmapGoal["status"] }) {
  const label = status ? GOAL_STATUS_LABELS[status as GoalStatus] : "No status";
  return (
    <Tooltip delay={400}>
      <span
        className="mt-[5px] inline-block size-2 shrink-0 rounded-full"
        style={{ background: status ? GOAL_STATUS_DOT[status as GoalStatus] : "var(--ink-mute)" }}
        aria-label={label}
      />
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip>
  );
}

function RoadmapCardItem({ card, selected, selectNode }: { card: RoadmapCard; selected: boolean; selectNode: (id: string) => void }) {
  const Icon = card.kind === "bug" ? Bug : CheckSquare;
  const status = card.status as TaskStatus | null;
  const blocked = card.blocked_by.length > 0;
  return (
    <button
      type="button"
      onClick={() => selectNode(card.id)}
      aria-pressed={selected}
      data-node-id={card.id}
      className={cn(
        "group flex w-full flex-col gap-1.5 rounded-lg border border-[var(--line)] bg-[var(--paper)] p-2.5 text-left text-[12px] transition-colors hover:border-[var(--line-strong)]",
        selected && "border-[var(--line-strong)] bg-[var(--paper-2)]",
      )}
    >
      <span className="flex items-start gap-1.5">
        <Icon size={11} className="mt-[3px] shrink-0 text-[var(--ink-3)] group-hover:text-[var(--ink)]" aria-label={card.kind} />
        <span className="line-clamp-2 text-[var(--ink)]">{card.title}</span>
      </span>
      <span className="mono flex flex-wrap items-center gap-1 text-[10px] text-[var(--ink-3)]">
        {status ? (
          <span className="inline-flex items-center gap-1">
            <span className="inline-block size-1.5 rounded-full" style={{ background: STATUS_DOT[status] ?? "var(--ink-mute)" }} aria-hidden="true" />
            {STATUS_LABELS[status] ?? status}
          </span>
        ) : null}
        {card.priority ? (
          <Chip size="sm" variant="tertiary" className="rounded-full px-1.5 py-0 text-[9px] text-[var(--ink-mute)]">
            <Chip.Label>{card.priority}</Chip.Label>
          </Chip>
        ) : null}
        {card.subtasks ? (
          <Chip
            size="sm"
            variant="tertiary"
            className={cn("gap-1 rounded-full px-1.5 py-0 text-[9px] text-[var(--ink-mute)]", card.subtasks.done === card.subtasks.total && "text-[var(--ink-3)]")}
            title={`${card.subtasks.done} of ${card.subtasks.total} subtasks done`}
          >
            <ListChecks size={9} /> <Chip.Label>{card.subtasks.done}/{card.subtasks.total}</Chip.Label>
          </Chip>
        ) : null}
        {card.due_date ? (
          <Chip size="sm" variant="tertiary" className="gap-1 rounded-full px-1.5 py-0 text-[9px] text-[var(--ink-mute)]" title={card.due_date}>
            <CalendarDays size={9} />{" "}
            <Chip.Label>{new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(card.due_date))}</Chip.Label>
          </Chip>
        ) : null}
      </span>
      {blocked ? (
        <span className="mono flex items-center gap-1 text-[10px] text-[var(--warn)]" title={card.blocked_by.join(", ")}>
          <AlertTriangle size={9} className="shrink-0" />
          <span className="truncate">← {card.blocked_by[0]}{card.blocked_by.length > 1 ? ` +${card.blocked_by.length - 1}` : ""}</span>
        </span>
      ) : null}
    </button>
  );
}
