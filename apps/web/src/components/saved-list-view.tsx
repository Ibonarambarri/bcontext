"use client";

/**
 * SavedListView — the ONE list renderer for every list-shaped saved view,
 * chosen by `view-canvas.tsx`: `list` views, `table` views (there is no
 * dedicated table renderer) and old `timeline` views, which the contract's
 * view schema coerces to `list` on parse.
 *
 * Anatomy (family look shared with the Integrations queue and Activity):
 *   header meta + Filter button → collapsible filter panel (grid-rows
 *   0fr→1fr, cubic-bezier(0.16,1,0.3,1), count badge, inert) →
 *   ListView rows (kind glyph · title · tag chips · status · relative time)
 *   → EmptyState when nothing matches.
 *
 * Data: the view's own query is resolved server-side by the workspace
 * context (`activeViewResult`, with `applied_filters` shown as lens chips);
 * the Filter panel refines CLIENT-SIDE over those rows — no endpoint of its
 * own. Rows open in the floating node panel via `selectNode()`.
 */

import { useMemo, useState } from "react";
import type { ComponentType } from "react";
import {
  Box,
  CalendarDays,
  CircleSlash2,
  Inbox,
  SlidersHorizontal,
  Tag as TagIcon,
  X,
} from "lucide-react";
import {
  Button,
  Calendar,
  Chip,
  DateField,
  DatePicker,
  Label,
  ListBox,
  ScrollShadow,
  Select,
} from "@heroui/react";
import { EmptyState } from "@/components/ui/empty-state";
import { ListView } from "@/components/ui/list-view";
import { type CalendarDate, parseDate } from "@internationalized/date";
import { ViewSkeleton } from "@/components/skeletons";
import {
  applyListSessionFilters,
  countActiveListFilters,
  EMPTY_LIST_FILTERS,
  sortListNodes,
  type ListSessionFilters,
} from "@/lib/list-view";
import { getNodeTags, statusLabel, type KnowledgeNode, type NodeKind, type NodeStatus } from "@bcontext-dev/contract/types";
import { GOAL_STATUS_DOT } from "@/lib/goals/presentation";
import { cn, formatRelative } from "@bcontext-dev/contract/utils";
import type { ViewQuery } from "@bcontext-dev/contract/views/schema";
import type { SavedView } from "@bcontext-dev/contract/views/types";
import { nodeKindIcon } from "./node-kind-icon";
import { TagColorDot } from "./tag-color-dot";
import { NodeRevealRegion } from "./node-reveal";
import { useWorkspace } from "./workspace-context";
import { useHoverDwell } from "@/lib/use-hover-dwell";

/**
 * Same palette the board columns use — one status color vocabulary. A list
 * is not a board, so it can hold both kinds of status: a goal row keeps its
 * health dot instead of falling through to the neutral one.
 */
const STATUS_DOT_COLOR: Record<string, string> = {
  todo: "oklch(70% 0.02 80)",
  in_progress: "var(--accent)",
  blocked: "var(--warn)",
  done: "oklch(70% 0 0)",
  review: "oklch(65% 0.08 250)",
  backlog: "var(--ink-mute)",
  archived: "var(--line-strong)",
  ...GOAL_STATUS_DOT,
};

const KIND_LABELS: Record<NodeKind, string> = {
  doc: "Doc",
  task: "Task",
  decision: "Decision",
  meeting: "Meeting",
  bug: "Bug",
  adr: "ADR",
  entity: "Entity",
  skill: "Skill",
  data: "Data",
  credential: "Credential",
  goal: "Goal",
};

export function SavedListView({ view }: { view: SavedView }) {
  const { nodes, activeViewResult, inspectedNodeId, selectNode } = useWorkspace();
  const [filters, setFilters] = useState<ListSessionFilters>(EMPTY_LIST_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const resolvedNodes = useMemo(() => {
    if (!activeViewResult) return [];
    const allowed = new Set(activeViewResult.node_ids);
    return nodes.filter((node) => allowed.has(node.id));
  }, [activeViewResult, nodes]);

  // Facets come from the resolved rows themselves — the panel only ever
  // offers values that can actually match something in this lens.
  const kindOptions = useMemo(
    () => [...new Set(resolvedNodes.map((node) => node.kind))].sort((a, b) => a.localeCompare(b)),
    [resolvedNodes],
  );
  const statusOptions = useMemo(
    () =>
      [...new Set(resolvedNodes.map((node) => node.status).filter((status): status is NodeStatus => Boolean(status)))]
        .sort((a, b) => a.localeCompare(b)),
    [resolvedNodes],
  );
  const tagOptions = useMemo(() => {
    const byId = new Map(resolvedNodes.flatMap((node) => node.tags).map((tag) => [tag.id, tag]));
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [resolvedNodes]);

  // A lens pinned to one kind (e.g. a docs-only view) makes a kind filter
  // noise; a lens with no statuses makes the status filter noise.
  const showKind = view.query.kinds.length !== 1 && kindOptions.length > 1;
  const showStatus = statusOptions.length > 0;

  const visibleNodes = useMemo(
    () => sortListNodes(applyListSessionFilters(resolvedNodes, filters), view.presentation.sort_by),
    [filters, resolvedNodes, view.presentation.sort_by],
  );

  const activeFilterCount = useMemo(() => countActiveListFilters(filters), [filters]);
  const lensChips = useMemo(() => lensLabels(activeViewResult?.applied_filters ?? view.query), [activeViewResult, view.query]);

  if (!activeViewResult) return <ViewSkeleton />;

  const panelId = `list-filters-${view.id}`;
  return (
    <ScrollShadow className="scroll h-full overflow-y-auto" role="region" aria-label={view.name}>
      <div className="mx-auto max-w-5xl px-4 pb-16 pt-4 sm:px-10 sm:pt-5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0">
            <p className="m-0 text-[12px] text-[var(--ink-3)]">
              {visibleNodes.length === resolvedNodes.length
                ? `${resolvedNodes.length} ${resolvedNodes.length === 1 ? "node" : "nodes"}`
                : `${visibleNodes.length} of ${resolvedNodes.length} nodes`}
              {activeViewResult.scope.truncated ? " · limited result" : ""}
            </p>
          </div>
          <span className="ml-auto" />
          <Button
            size="sm"
            variant={filtersOpen ? "secondary" : "outline"}
            aria-expanded={filtersOpen}
            aria-controls={panelId}
            onPress={() => setFiltersOpen((open) => !open)}
            className={cn("gap-1.5", filtersOpen && "border-[var(--line-strong)]")}
          >
            <SlidersHorizontal
              size={13}
              className={cn(
                "transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
                filtersOpen && "rotate-90",
              )}
            />
            Filter
            {activeFilterCount > 0 ? (
              <Chip size="sm" variant="soft" color="accent" className="h-4 min-w-4 px-1 text-[10px]">
                {activeFilterCount}
              </Chip>
            ) : null}
          </Button>
        </div>

        {/* Collapsible filters — grid-rows height animation, no layout jumps. */}
        <div
          id={panelId}
          inert={!filtersOpen}
          className={cn(
            "grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
            filtersOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <div
              className={cn(
                "transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
                filtersOpen ? "translate-y-0 opacity-100" : "-translate-y-2 opacity-0",
              )}
            >
              <NodeFiltersBar
                filters={filters}
                setFilters={setFilters}
                showKind={showKind}
                showStatus={showStatus}
                kindOptions={kindOptions}
                statusOptions={statusOptions}
                tagOptions={tagOptions}
                lensChips={lensChips}
              />
              <div className="h-1" />
            </div>
          </div>
        </div>

        {resolvedNodes.length === 0 ? (
          <LensEmptyState />
        ) : visibleNodes.length === 0 ? (
          <FiltersEmptyState onClear={() => setFilters(EMPTY_LIST_FILTERS)} />
        ) : (
          <div className="mt-4 overflow-hidden rounded-[14px] border border-[var(--line)] bg-[var(--paper)]">
            <ListView
              aria-label={view.name}
              variant="secondary"
              onAction={(key) => selectNode(String(key))}
              className="[&_.list-view\_\_item:last-child]:border-b-0"
            >
              {visibleNodes.map((node) => (
                <NodeListRow key={node.id} node={node} renderer={view.presentation.renderer} inspected={inspectedNodeId === node.id} />
              ))}
            </ListView>
          </div>
        )}
      </div>
    </ScrollShadow>
  );
}

function NodeListRow({ node, renderer, inspected }: { node: KnowledgeNode; renderer: string; inspected: boolean }) {
  const Icon = nodeKindIcon(node.kind);
  const { address } = useWorkspace();
  const { expanded, onMouseEnter, onMouseLeave } = useHoverDwell();
  return (
    <ListView.Item
      id={node.id}
      textValue={node.title}
      data-node-id={node.id}
      data-renderer={renderer}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={cn("cursor-pointer px-3 py-2.5", inspected && "bg-[var(--paper-3)]")}
    >
      {/*
       * ListView.Item is the react-aria-components collection node
       * (GridListItem) — its content stays a plain child (no popup trigger
       * wrapper) so selection, onAction and keyboard nav keep working
       * untouched. The reveal region below the title expands in place on
       * hover-dwell instead of opening a floating card.
       */}
      <div className="contents">
        <ListView.ItemContent className="min-w-0 flex-col items-start gap-0">
          <div className="flex w-full min-w-0 items-center gap-3">
            <Icon size={15} aria-label={KIND_LABELS[node.kind] ?? node.kind} className="shrink-0 text-[var(--ink-3)]" />
            <ListView.Title className="min-w-0 truncate text-[13px] font-normal text-[var(--ink)]">
              {node.title}
            </ListView.Title>
          </div>
          <NodeRevealRegion
            open={expanded}
            nodeId={node.id}
            workspace={address}
            tags={getNodeTags(node)}
            status={node.status}
            className="w-full pl-[27px]"
          />
        </ListView.ItemContent>
        <ListView.ItemAction className="flex shrink-0 items-center gap-1.5 self-start">
          {node.tags.slice(0, 2).map((tag) => (
            <Chip key={tag.id} size="sm" variant="soft" className="hidden items-center gap-1 text-[10px] text-[var(--ink-2)] sm:inline-flex">
              <TagColorDot tagId={tag.id} />
              <Chip.Label>#{tag.name}</Chip.Label>
            </Chip>
          ))}
          {node.tags.length > 2 ? (
            <span className="hidden text-[10px] text-[var(--ink-mute)] sm:inline">+{node.tags.length - 2}</span>
          ) : null}
          {node.status ? (
            <Chip size="sm" variant="soft" className="shrink-0 gap-1 text-[10px]">
              <span
                aria-hidden
                className="size-1.5 rounded-full"
                style={{ background: STATUS_DOT_COLOR[node.status] ?? "var(--ink-mute)" }}
              />
              <Chip.Label>{statusLabel(node.status)}</Chip.Label>
            </Chip>
          ) : null}
          <time dateTime={node.updated_at} className="w-16 text-right text-[11px] tabular-nums text-muted">
            {formatRelative(node.updated_at)}
          </time>
        </ListView.ItemAction>
      </div>
    </ListView.Item>
  );
}

/* ── Filters (Activity FiltersBar pattern, adapted to nodes) ─────────── */

function NodeFiltersBar({
  filters,
  setFilters,
  showKind,
  showStatus,
  kindOptions,
  statusOptions,
  tagOptions,
  lensChips,
}: {
  filters: ListSessionFilters;
  setFilters: React.Dispatch<React.SetStateAction<ListSessionFilters>>;
  showKind: boolean;
  showStatus: boolean;
  kindOptions: NodeKind[];
  statusOptions: NodeStatus[];
  tagOptions: Array<{ id: string; name: string }>;
  lensChips: string[];
}) {
  const set = <K extends keyof ListSessionFilters>(key: K, value: ListSessionFilters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }));
  const activeCount = Object.values(filters).filter((value) => value !== "").length;
  const hasActiveFilters = activeCount > 0;

  return (
    <section
      aria-label="Node filters"
      className="mt-3 rounded-[calc(var(--radius)+6px)] border border-border bg-surface/90 p-4 sm:p-5"
    >
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold tracking-tight text-foreground">Filter nodes</h2>
        <Chip size="sm" variant={hasActiveFilters ? "soft" : "secondary"} color={hasActiveFilters ? "accent" : "default"}>
          <Chip.Label>{hasActiveFilters ? `${activeCount} active` : "No filters"}</Chip.Label>
        </Chip>
      </header>

      <div className="grid grid-cols-2 gap-3.5 md:grid-cols-3 lg:grid-cols-5">
        {showKind ? (
          <FilterField label="Kind" Icon={Box}>
            <FilterSelect
              aria-label="Kind"
              value={filters.kind}
              onChange={(value) => set("kind", value as ListSessionFilters["kind"])}
              items={[
                { id: "", label: "All kinds" },
                ...kindOptions.map((kind) => ({ id: kind, label: KIND_LABELS[kind] ?? kind })),
              ]}
            />
          </FilterField>
        ) : null}
        {showStatus ? (
          <FilterField label="Status" Icon={CircleSlash2}>
            <FilterSelect
              aria-label="Status"
              value={filters.status}
              onChange={(value) => set("status", value as ListSessionFilters["status"])}
              items={[
                { id: "", label: "All statuses" },
                ...statusOptions.map((status) => ({ id: status, label: statusLabel(status) })),
              ]}
            />
          </FilterField>
        ) : null}
        <FilterField label="Tag" Icon={TagIcon}>
          <FilterSelect
            aria-label="Tag"
            value={filters.tag}
            onChange={(value) => set("tag", value)}
            items={[{ id: "", label: "All tags" }, ...tagOptions.map((tag) => ({ id: tag.id, label: `#${tag.name}` }))]}
          />
        </FilterField>
        <FilterDate label="Updated from" value={filters.from} onChange={(value) => set("from", value)} />
        <FilterDate label="Updated to" value={filters.to} onChange={(value) => set("to", value)} />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {lensChips.length > 0 ? (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5" aria-label="View lens (saved with the view)">
            <span className="mono text-[9px] uppercase tracking-widest text-[var(--ink-mute)]">View lens</span>
            {lensChips.map((chip) => (
              <Chip key={chip} size="sm" variant="tertiary" className="rounded-full px-2 py-0.5 text-[9.5px] text-[var(--ink-2)]">
                <Chip.Label>{chip}</Chip.Label>
              </Chip>
            ))}
          </div>
        ) : null}
        <div className="ml-auto">
          <Button variant="ghost" size="sm" isDisabled={!hasActiveFilters} onPress={() => setFilters(EMPTY_LIST_FILTERS)}>
            <X size={14} /> Clear
          </Button>
        </div>
      </div>
    </section>
  );
}

function FilterField({ label, Icon, children }: { label: string; Icon: ComponentType<{ size?: number; className?: string }>; children: React.ReactNode }) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5">
      <Label className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
        <Icon size={13} className="opacity-80" />
        {label}
      </Label>
      {children}
    </div>
  );
}

function FilterSelect({
  "aria-label": ariaLabel,
  value,
  onChange,
  items,
}: {
  "aria-label": string;
  value: string;
  onChange: (value: string) => void;
  items: Array<{ id: string; label: string }>;
}) {
  return (
    <Select aria-label={ariaLabel} value={value} onChange={(key) => onChange(key == null ? "" : String(key))}>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {items.map((item) => (
            <ListBox.Item key={item.id} id={item.id} textValue={item.label}>
              {item.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

function toDateValue(iso: string): CalendarDate | null {
  if (!iso) return null;
  try {
    return parseDate(iso);
  } catch {
    return null;
  }
}

/** DatePicker with calendar popover, bridged to the "YYYY-MM-DD" strings the filters hold. */
function FilterDate({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <DatePicker
      aria-label={label}
      value={toDateValue(value)}
      onChange={(next) => onChange(next ? next.toString() : "")}
      className="flex w-full min-w-0 flex-col gap-1.5"
    >
      <Label className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
        <CalendarDays size={13} className="opacity-80" />
        {label}
      </Label>
      <DateField.Group fullWidth className="text-foreground [&_.date-input-group__segment]:text-foreground">
        <DateField.Input>{(segment) => <DateField.Segment segment={segment} />}</DateField.Input>
        <DateField.Suffix>
          <DatePicker.Trigger>
            <DatePicker.TriggerIndicator />
          </DatePicker.Trigger>
        </DateField.Suffix>
      </DateField.Group>
      <DatePicker.Popover>
        <Calendar aria-label={label}>
          <Calendar.Header>
            <Calendar.YearPickerTrigger>
              <Calendar.YearPickerTriggerHeading />
              <Calendar.YearPickerTriggerIndicator />
            </Calendar.YearPickerTrigger>
            <Calendar.NavButton slot="previous" />
            <Calendar.NavButton slot="next" />
          </Calendar.Header>
          <Calendar.Grid>
            <Calendar.GridHeader>
              {(day) => <Calendar.HeaderCell>{day}</Calendar.HeaderCell>}
            </Calendar.GridHeader>
            <Calendar.GridBody>{(date) => <Calendar.Cell date={date} />}</Calendar.GridBody>
          </Calendar.Grid>
          <Calendar.YearPickerGrid>
            <Calendar.YearPickerGridBody>
              {({ year }) => <Calendar.YearPickerCell year={year} />}
            </Calendar.YearPickerGridBody>
          </Calendar.YearPickerGrid>
        </Calendar>
      </DatePicker.Popover>
    </DatePicker>
  );
}

/* ── Empty states ────────────────────────────────────────────────────── */

function LensEmptyState() {
  return (
    <EmptyState className="mt-4 min-h-[320px] rounded-2xl border border-dashed border-[var(--line)] bg-[var(--paper-2)] px-6 py-12">
      <EmptyState.Header>
        <EmptyState.Media variant="icon">
          <Inbox size={20} />
        </EmptyState.Media>
        <EmptyState.Title className="text-[16px] text-[var(--ink)]">Nothing in this lens yet</EmptyState.Title>
        <EmptyState.Description className="max-w-[430px]">
          Nodes matching this view&rsquo;s lens will appear here as soon as they exist in the workspace.
        </EmptyState.Description>
      </EmptyState.Header>
    </EmptyState>
  );
}

function FiltersEmptyState({ onClear }: { onClear: () => void }) {
  return (
    <EmptyState className="mt-4 min-h-[240px] rounded-2xl border border-dashed border-[var(--line)] bg-[var(--paper-2)] px-6 py-10">
      <EmptyState.Header>
        <EmptyState.Media variant="icon">
          <SlidersHorizontal size={18} />
        </EmptyState.Media>
        <EmptyState.Title className="text-[15px] text-[var(--ink)]">No nodes match these filters</EmptyState.Title>
        <EmptyState.Description className="max-w-[380px]">
          The view has nodes, but none pass the session filters above.
        </EmptyState.Description>
      </EmptyState.Header>
      <EmptyState.Content>
        <Button size="sm" variant="outline" onPress={onClear}>
          <X size={13} /> Clear filters
        </Button>
      </EmptyState.Content>
    </EmptyState>
  );
}

/* ── Lens chips — the view's own persisted query, resolved server-side ── */

function lensLabels(query: ViewQuery): string[] {
  return [
    ...query.kinds.map((value) => `kind:${value}`),
    ...query.statuses.map((value) => `status:${value}`),
    ...query.tags_any.map((value) => `tag:${value}`),
    ...query.tags_all.map((value) => `tag-all:${value}`),
    ...query.source.map((value) => `source:${value}`),
    ...query.actor.map((value) => `actor:${value}`),
    ...query.dates.map((value) => `${value.field}:${value.from ? `from ${value.from.slice(0, 10)}` : ""}${value.from && value.to ? " " : ""}${value.to ? `to ${value.to.slice(0, 10)}` : ""}`),
    ...query.root_node_ids.map(() => "root"),
    ...(query.traversal ? [`depth:${query.traversal.depth}`] : []),
  ];
}
