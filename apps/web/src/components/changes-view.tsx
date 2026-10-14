"use client";

/**
 * The Activity feed — the `changes` system view and any custom view with the
 * `changes` renderer, mounted by `view-canvas.tsx`.
 *
 * Reads `GET /api/activity` (slim rows, `fields=list`, cursor-paged) with
 * the filters as query params, `GET /api/activity/facets` for the filter
 * options and `GET /api/activity/:id` for the before/after snapshot of one
 * expanded row. Every workspace broadcast that can change the feed bumps
 * `realtimeTick`, which reloads the first page. Rows that point at a node the
 * workspace context knows open it in the floating panel; the rest are
 * read-only. Revert and review are shown only as the API's `permissions`
 * allow — the buttons never assume.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ComponentType } from "react";
import {
  ArrowRightLeft,
  Bot,
  Box,
  CalendarDays,
  Globe,
  ListChecks,
  Network,
  Tag as TagIcon,
  UserRound,
  ExternalLink,
  FilePlus2,
  Layers,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Trash2,
  TextCursorInput,
  X,
} from "lucide-react";
import {
  Button,
  Calendar,
  Chip,
  ComboBox,
  DateField,
  DatePicker,
  Disclosure,
  Input,
  Label,
  ListBox,
  Select,
  Spinner,
  Tooltip,
} from "@heroui/react";
import { type CalendarDate, parseDate } from "@internationalized/date";
import { ListSkeleton } from "@/components/skeletons";
import type { ActivityEntry, ActivityKind } from "@bcontext-dev/contract/activity";
import { useWorkspaceBroadcast } from "@/lib/collab/workspace-realtime";
import { diffLines } from "@/lib/line-diff";
import type { NodeKind } from "@bcontext-dev/contract/types";
import { cn, formatRelative } from "@bcontext-dev/contract/utils";
import { useWorkspace } from "./workspace-context";
import { workspaceApiRef } from "@/web/workspace-url";

interface ChangesResponse {
  changes: ActivityEntry[];
  next_cursor: string | null;
  retention: { operational_days: number; audit: string };
  permissions: { read: boolean; review: boolean; revert: boolean };
}

interface Filters {
  actor: "" | "human" | "agent" | "system";
  action: "" | ActivityKind;
  kind: "" | NodeKind;
  tag: string;
  node: string;
  source: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: Filters = { actor: "", action: "", kind: "", tag: "", node: "", source: "", from: "", to: "" };
/** First paint loads one screenful; "Load more" pages by cursor in chunks. */
const PAGE_SIZE = 30;
const ACTIONS: ActivityKind[] = ["create", "update", "rename", "move", "delete", "agent", "workspace"];
const KINDS: NodeKind[] = ["doc", "task", "decision", "meeting", "bug", "adr", "entity", "skill", "goal"];

const ACTION_ICONS: Record<ActivityKind, typeof FilePlus2> = {
  create: FilePlus2,
  update: Pencil,
  rename: TextCursorInput,
  move: ArrowRightLeft,
  delete: Trash2,
  agent: Bot,
  workspace: Layers,
};

function ActionIcon({ kind, className }: { kind: ActivityKind; className?: string }) {
  const Icon = ACTION_ICONS[kind] ?? Pencil;
  return <Icon size={14} className={className} aria-hidden />;
}

export function ChangesView({
  title = "Changes",
  // Accepted for the caller's sake (view-canvas.tsx passes the view's
  // description); the feed renders no description banner.
  description = "Supervise human and agent writes without leaving the feed.",
}: { title?: string; description?: string }) {
  void description;
  const { address, nodes, inspectedNodeId, selectNode } = useWorkspace();
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<ChangesResponse["permissions"]>({ read: true, review: false, revert: false });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [realtimeTick, setRealtimeTick] = useState(0);
  // Lazy per-entry detail: the feed ships slim rows (`fields=list`, no
  // before/after snapshots); expanding a row fetches the full entry once.
  const [details, setDetails] = useState<Record<string, ActivityEntry>>({});
  const [detailPending, setDetailPending] = useState<Record<string, boolean>>({});
  const [sources, setSources] = useState<string[]>([]);

  const load = useCallback(async (cursor?: string | null) => {
    cursor ? setLoadingMore(true) : setLoading(true);
    const params = new URLSearchParams({ workspace: workspaceApiRef(address), limit: String(PAGE_SIZE), fields: "list" });
    if (filters.actor) params.set("actor", filters.actor);
    if (filters.action) params.set("kind", filters.action);
    if (filters.kind) params.set("node_kind", filters.kind);
    if (filters.tag) params.set("tag", filters.tag);
    if (filters.node) params.set("node", filters.node);
    if (filters.source) params.set("source", filters.source);
    if (filters.from) params.set("from", `${filters.from}T00:00:00.000Z`);
    if (filters.to) params.set("to", `${filters.to}T23:59:59.999Z`);
    if (cursor) params.set("cursor", cursor);
    try {
      const response = await fetch(`/api/activity?${params.toString()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 403 ? "You do not have permission to read this feed." : "Changes could not be loaded.");
      const payload = await response.json() as ChangesResponse;
      setEntries((current) => cursor ? [...current, ...payload.changes] : payload.changes);
      setNextCursor(payload.next_cursor);
      setPermissions(payload.permissions);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Changes could not be loaded.");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [filters, address]);

  useEffect(() => { void load(); }, [load, realtimeTick]);

  const loadDetail = useCallback(async (entryId: string) => {
    setDetailPending((current) => ({ ...current, [entryId]: true }));
    try {
      const response = await fetch(
        `/api/activity/${encodeURIComponent(entryId)}?workspace=${encodeURIComponent(workspaceApiRef(address))}`,
        { cache: "no-store" },
      );
      if (!response.ok) return;
      const payload = await response.json() as { change?: ActivityEntry };
      if (payload.change) setDetails((current) => ({ ...current, [entryId]: payload.change! }));
    } catch {
      // The slim row stays visible; expanding again retries.
    } finally {
      setDetailPending((current) => ({ ...current, [entryId]: false }));
    }
  }, [address]);

  // Filter options come from a light aggregate endpoint — never derived from
  // (and therefore never requiring) the loaded feed pages.
  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/activity/facets?workspace=${encodeURIComponent(workspaceApiRef(address))}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((payload: { facets?: { sources?: string[] } }) => {
        if (!cancelled) setSources(payload.facets?.sources ?? []);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [address, realtimeTick]);

  const refreshRealtime = useCallback(() => setRealtimeTick((value) => value + 1), []);
  useWorkspaceBroadcast("node.created", refreshRealtime);
  useWorkspaceBroadcast("node.updated", refreshRealtime);
  useWorkspaceBroadcast("node.renamed", refreshRealtime);
  useWorkspaceBroadcast("node.moved", refreshRealtime);
  useWorkspaceBroadcast("node.deleted", refreshRealtime);
  useWorkspaceBroadcast("backlink.changed", refreshRealtime);

  const tags = useMemo(() => {
    const byId = new Map(nodes.flatMap((node) => node.tags).map((tag) => [tag.id, tag]));
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [nodes]);
  const knownNodes = useMemo(() => new Set(nodes.map((node) => node.id)), [nodes]);

  return (
    <div className="scroll h-full overflow-y-auto" role="region" aria-label={title}>
      <div className="mx-auto max-w-6xl px-4 pb-16 pt-4 sm:px-10 sm:pt-5">
        {/* Title lives in the shell's content header; kept here only as the region's accessible name. */}
        <FiltersBar
          filters={filters}
          setFilters={setFilters}
          nodes={nodes}
          tags={tags}
          sources={sources}
          onRefresh={() => void load()}
        />

        {error ? <Message>{error}</Message> : loading ? <ListSkeleton rows={8} className="mt-5" label="Loading changes" /> : entries.length === 0 ? <Message>No changes match these filters.</Message> : (
          <ol className="mt-5 divide-y divide-[var(--line)] rounded-md border border-[var(--line)] bg-[var(--paper)]" aria-live="polite">
            {entries.map((entry) => {
              const expanded = expandedId === entry.id;
              const inspectable = Boolean(entry.node_id && knownNodes.has(entry.node_id));
              return (
                <li key={entry.id}>
                  <Disclosure
                    isExpanded={expanded}
                    onExpandedChange={(next) => {
                      setExpandedId(next ? entry.id : null);
                      if (next && !details[entry.id] && !detailPending[entry.id]) void loadDetail(entry.id);
                    }}
                  >
                    <Disclosure.Heading>
                      <Button
                        slot="trigger"
                        variant="ghost"
                        data-renderer="changes"
                        data-node-id={entry.node_id ?? undefined}
                        fullWidth className="h-auto w-full min-w-0 justify-start gap-3 rounded-none px-3 py-3 text-left"
                        onPress={() => { if (inspectable && entry.node_id) selectNode(entry.node_id, { blockId: entry.block_id }); }}
                      >
                        <ActionIcon kind={entry.kind} className="mt-0.5 shrink-0 text-[var(--ink-3)]" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px]">{entry.node_title ?? entry.summary ?? "Workspace event"}{entry.block_id ? ` · #${entry.block_id}` : ""}</span>
                          <span className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[var(--ink-mute)]">
                            <span className="inline-flex flex-wrap items-center gap-1.5">
                              <span>{actorName(entry)}</span>
                              {actorKind(entry) && <KindChip>{actorKind(entry)}</KindChip>}
                              <span>{entry.action}</span>
                            </span>
                            {entry.source && <span>via {entry.source}</span>}
                          </span>
                        </span>
                        {entry.node_kind && (
                          <Chip size="sm" variant="soft" className="shrink-0">
                            {entry.node_kind}
                          </Chip>
                        )}
                        {entry.audit && <ShieldCheck size={13} aria-label="Audit evidence linked" className="shrink-0 text-[var(--ink-3)]" />}
                        {inspectable && inspectedNodeId === entry.node_id && <span className="shrink-0 text-[10px] text-muted">inspecting</span>}
                        <time dateTime={entry.ts} className="shrink-0 text-[11px] text-muted">{formatRelative(entry.ts)}</time>
                        <Disclosure.Indicator className="shrink-0 text-[var(--ink-mute)]" />
                      </Button>
                    </Disclosure.Heading>
                    <Disclosure.Content>
                      <ChangeDetails
                        entry={details[entry.id] ?? entry}
                        detailLoading={Boolean(detailPending[entry.id]) && !details[entry.id]}
                        permissions={permissions}
                        onInspect={(id, blockId) => selectNode(id, { blockId })}
                      />
                    </Disclosure.Content>
                  </Disclosure>
                </li>
              );
            })}
          </ol>
        )}
        <div className="mt-4 flex items-center justify-between gap-3">
          {nextCursor && !loading ? (
            <Button
              variant="outline"
              isDisabled={loadingMore}
              onPress={() => void load(nextCursor)}
            >
              {loadingMore && <Spinner size="sm" />} Load more
            </Button>
          ) : <span />}
          {!loading && <span className="text-[11px] text-muted">{entries.length} loaded</span>}
        </div>
      </div>
    </div>
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

function FiltersBar({
  filters,
  setFilters,
  nodes,
  tags,
  sources,
  onRefresh,
}: {
  filters: Filters;
  setFilters: React.Dispatch<React.SetStateAction<Filters>>;
  nodes: ReturnType<typeof useWorkspace>["nodes"];
  tags: ReturnType<typeof useWorkspace>["nodes"][number]["tags"];
  sources: string[];
  onRefresh: () => void;
}) {
  const set = <K extends keyof Filters>(key: K, value: Filters[K]) => setFilters((current) => ({ ...current, [key]: value }));
  const activeCount = useMemo(() => Object.values(filters).filter((value) => value !== "").length, [filters]);
  const hasActiveFilters = activeCount > 0;

  return (
    <section
      aria-label="Change filters"
      className="mt-3 rounded-[calc(var(--radius)+6px)] border border-border bg-surface/90 p-4 sm:p-5"
    >
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold tracking-tight text-foreground">Filter activity</h2>
        <Chip size="sm" variant={hasActiveFilters ? "soft" : "secondary"} color={hasActiveFilters ? "accent" : "default"}>
          <Chip.Label>{hasActiveFilters ? `${activeCount} active` : "No filters"}</Chip.Label>
        </Chip>
      </header>

      <div className="grid grid-cols-2 gap-3.5 md:grid-cols-3 lg:grid-cols-6">
        <FilterField label="Actor" Icon={UserRound}>
          <FilterSelect
            aria-label="Actor"
            value={filters.actor}
            onChange={(value) => set("actor", value as Filters["actor"])}
            items={[
              { id: "", label: "All actors" },
              { id: "human", label: "Human" },
              { id: "agent", label: "Agent" },
              { id: "system", label: "System" },
            ]}
          />
        </FilterField>
        <FilterField label="Action" Icon={ListChecks}>
          <FilterSelect
            aria-label="Action"
            value={filters.action}
            onChange={(value) => set("action", value as Filters["action"])}
            items={[{ id: "", label: "All actions" }, ...ACTIONS.map((value) => ({ id: value, label: value }))]}
          />
        </FilterField>
        <FilterField label="Node kind" Icon={Box}>
          <FilterSelect
            aria-label="Node kind"
            value={filters.kind}
            onChange={(value) => set("kind", value as Filters["kind"])}
            items={[{ id: "", label: "All kinds" }, ...KINDS.map((value) => ({ id: value, label: value }))]}
          />
        </FilterField>
        <FilterField label="Tag" Icon={TagIcon}>
          <FilterSelect
            aria-label="Tag"
            value={filters.tag}
            onChange={(value) => set("tag", value)}
            items={[{ id: "", label: "All tags" }, ...tags.map((tag) => ({ id: tag.id, label: `#${tag.name}` }))]}
          />
        </FilterField>
        <FilterField label="Node" Icon={Network}>
          <FilterSelect
            aria-label="Node"
            value={filters.node}
            onChange={(value) => set("node", value)}
            items={[
              { id: "", label: "All nodes" },
              ...nodes.toSorted((a, b) => a.title.localeCompare(b.title)).map((node) => ({ id: node.id, label: node.title })),
            ]}
          />
        </FilterField>
        <FilterField label="Source" Icon={Globe}>
          <ComboBox
            allowsCustomValue
            aria-label="Source"
            className="w-full min-w-0"
            inputValue={filters.source}
            onInputChange={(value) => set("source", value)}
          >
            <ComboBox.InputGroup>
              <Input placeholder="Any source" className="w-full min-w-0" />
              <ComboBox.Trigger />
            </ComboBox.InputGroup>
            <ComboBox.Popover>
              <ListBox renderEmptyState={() => <p className="px-2 py-2 text-[10px] text-[var(--ink-mute)]">No known sources yet.</p>}>
                {sources.map((source) => (
                  <ListBox.Item key={source} id={source} textValue={source}>
                    {source}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </ComboBox.Popover>
          </ComboBox>
        </FilterField>
      </div>

      <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-end">
        <div className="grid flex-1 grid-cols-1 gap-3.5 sm:max-w-md sm:grid-cols-2">
          <FilterDate label="From" value={filters.from} onChange={(value) => set("from", value)} />
          <FilterDate label="To" value={filters.to} onChange={(value) => set("to", value)} />
        </div>
        <div className="flex items-center justify-end gap-2 sm:ml-auto">
          <Button variant="ghost" size="sm" isDisabled={!hasActiveFilters} onPress={() => setFilters(EMPTY_FILTERS)}>
            <X size={14} /> Clear
          </Button>
          <Tooltip delay={0}>
            <Button isIconOnly size="sm" variant="secondary" aria-label="Refresh results" onPress={onRefresh}>
              <RefreshCw size={14} />
            </Button>
            <Tooltip.Content>
              <p>Refresh results</p>
            </Tooltip.Content>
          </Tooltip>
        </div>
      </div>
    </section>
  );
}

/** DatePicker with full calendar popover (imported Filter Panel pattern), bridged to the "YYYY-MM-DD" filter strings. */
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
  triggerClassName,
}: {
  "aria-label": string;
  value: string;
  onChange: (value: string) => void;
  items: Array<{ id: string; label: string }>;
  triggerClassName?: string;
}) {
  return (
    <Select aria-label={ariaLabel} value={value} onChange={(key) => onChange(key == null ? "" : String(key))}>
      <Select.Trigger className={triggerClassName}>
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

function ChangeDetails({ entry, detailLoading = false, permissions, onInspect }: { entry: ActivityEntry; detailLoading?: boolean; permissions: ChangesResponse["permissions"]; onInspect: (id: string, blockId?: string | null) => void }) {
  return (
    <div className="border-t border-[var(--line)] px-4 py-4 text-[11px]">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-w-0">
          <h3 className="mono mb-2 text-[9px] uppercase tracking-wider text-[var(--ink-mute)]">Before / after</h3>
          {detailLoading
            ? <div className="flex min-h-16 items-center gap-2 text-[var(--ink-3)]"><Spinner size="sm" /> Loading change detail…</div>
            : <SnapshotDiff entry={entry} />}
        </div>
        <aside className="space-y-4 border-t border-[var(--line)] pt-4 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0">
          <div>
            <span className="mono block text-[8.5px] uppercase text-[var(--ink-mute)]">Actor</span>
            <span className="inline-flex flex-wrap items-center gap-1.5 break-all text-[var(--ink-2)]">
              <span>{actorName(entry)}</span>
              <KindChip>{actorKind(entry) ?? "unknown"}</KindChip>
            </span>
          </div>
          <Detail label="Principal" value={entry.actor?.id ?? entry.actor_principal_id ?? entry.actor_id ?? "Not recorded"} />
          <Detail label="Correlation" value={entry.correlation_id ?? "Not recorded"} />
          <Detail label="Timestamp" value={new Date(entry.ts).toLocaleString()} />
          {entry.node_id && <button type="button" onClick={() => onInspect(entry.node_id!, entry.block_id)} className="text-left text-[var(--ink)] underline decoration-[var(--line-strong)] underline-offset-2">Inspect node{entry.block_id ? `#${entry.block_id}` : ""}</button>}
          {entry.affected_relations.length > 0 && <section><h4 className="mono mb-1 text-[8.5px] uppercase text-[var(--ink-mute)]">Affected relations</h4>{entry.affected_relations.map((relation, index) => <div key={`${relation.from_id}-${relation.to_id}-${index}`} className="mb-1 break-all"><button className="underline" onClick={() => onInspect(relation.from_id)}>{relation.from_id.slice(0, 8)}</button> {relation.operation} {relation.relation} → <button className="underline" onClick={() => onInspect(relation.to_id)}>{relation.to_id.slice(0, 8)}</button></div>)}</section>}
          {(entry.provenance.sources.length > 0 || entry.provenance.references.length > 0) && <section><h4 className="mono mb-1 text-[8.5px] uppercase text-[var(--ink-mute)]">Provenance</h4>{entry.provenance.via && <div>via {entry.provenance.via}</div>}{entry.provenance.sources.map((value) => <Reference key={`s-${value}`} value={value} />)}{entry.provenance.references.map((value) => <Reference key={`r-${value}`} value={value} />)}</section>}
          {entry.audit && <section><h4 className="mono mb-1 text-[8.5px] uppercase text-[var(--ink-mute)]">Audit evidence</h4><div>{entry.audit.action}</div><div className="mono break-all text-[9px] text-[var(--ink-mute)]">row {entry.audit.row_hash}</div></section>}
          {entry.review && <section><h4 className="mono mb-1 text-[8.5px] uppercase text-[var(--ink-mute)]">Proposal review</h4><div>{entry.review.status} · {entry.review.label}</div>{entry.review.review_url && permissions.review && <a href={entry.review.review_url} className="mt-1 inline-flex items-center gap-1 underline">Open accept/reject review <ExternalLink size={10} /></a>}</section>}
          <section><h4 className="mono mb-1 text-[8.5px] uppercase text-[var(--ink-mute)]">Revert</h4><p className="text-[var(--ink-3)]">{entry.revert.available && permissions.revert ? "Audited compensation is available." : entry.revert.reason}</p></section>
        </aside>
      </div>
    </div>
  );
}

function SnapshotDiff({ entry }: { entry: ActivityEntry }) {
  if (!entry.before && !entry.after) {
    return (
      <Fallback
        text={entry.snapshot_state === "available"
          ? "Snapshot detail could not be loaded. Collapse and expand the row to retry."
          : "No snapshot was recorded for this legacy or non-node event. The feed does not imply that it can be reverted."}
      />
    );
  }
  if (!entry.before) return <Fallback text="This creation has an after snapshot only; there is no prior node state." />;
  if (!entry.after) return <Fallback text="This deletion has a before snapshot only. Recovery is not promised without an explicit audited compensation contract." />;
  const fields: Array<[string, unknown, unknown]> = [
    ["title", entry.before.title, entry.after.title], ["status", entry.before.status, entry.after.status], ["priority", entry.before.priority, entry.after.priority], ["parent", entry.before.parent_id, entry.after.parent_id], ["tags", entry.before.tags.map((tag) => tag.name).join(", "), entry.after.tags.map((tag) => tag.name).join(", ")],
  ];
  const changedFields = fields.filter(([, before, after]) => JSON.stringify(before) !== JSON.stringify(after));
  const lines = diffLines(entry.before.content_md, entry.after.content_md).filter((line) => line.type !== "same").slice(0, 160);
  return (
    <div className="space-y-2">
      {changedFields.map(([label, before, after]) => (
        <div key={label} className="grid grid-cols-[70px_1fr_1fr] gap-2 border-b border-[var(--line)] pb-2">
          <span className="mono text-[8.5px] uppercase text-[var(--ink-mute)]">{label}</span>
          <span className="break-words rounded bg-danger/10 px-1.5 py-1 text-danger line-through">{String(before ?? "—")}</span>
          <span className="break-words rounded bg-success/10 px-1.5 py-1 text-success">{String(after ?? "—")}</span>
        </div>
      ))}
      {lines.length > 0 && (
        <div className="mono max-h-72 overflow-x-auto overflow-y-auto rounded border border-[var(--line)] p-2 text-[10px]">
          {lines.map((line, index) => (
            <div
              key={index}
              className={cn(
                "whitespace-pre px-1",
                line.type === "add" ? "bg-success/10 text-success" : "bg-danger/10 text-danger line-through",
              )}
            >
              {line.type === "add" ? "+" : "−"} {line.text || " "}
            </div>
          ))}
        </div>
      )}
      {changedFields.length === 0 && lines.length === 0 && <Fallback text="Snapshots exist, but the supervised node fields are identical. The event may describe a relation or attachment change." />}
    </div>
  );
}

function Reference({ value }: { value: string }) { const linked = /^(https?:\/\/|\/n\/)/.test(value); return linked ? <a href={value} className="block break-all underline">{value}</a> : <div className="break-all">{value}</div>; }
/**
 * The actor's display name (contract 0.1.9 `actor.name`), falling back to
 * the flat `actor_label` an older API still sends. Never a bare hash.
 */
function actorName(entry: ActivityEntry): string { return entry.actor?.name?.trim() || entry.actor_label; }
function actorKind(entry: ActivityEntry): string | null { return entry.actor?.kind ?? entry.actor_kind ?? null; }
function KindChip({ children }: { children: React.ReactNode }) { return <span className="mono inline-flex h-4 items-center rounded-full border border-[var(--line)] bg-[var(--paper-2)] px-1.5 text-[9px] leading-none tracking-wider text-[var(--ink-3)]">{children}</span>; }
function Detail({ label, value }: { label: string; value: string }) { return <div><span className="mono block text-[8.5px] uppercase text-[var(--ink-mute)]">{label}</span><span className="break-all text-[var(--ink-2)]">{value}</span></div>; }
function Fallback({ text }: { text: string }) { return <div className="rounded border border-dashed border-[var(--line-strong)] bg-[var(--paper-2)] px-3 py-3 text-[var(--ink-3)]">{text}</div>; }
function Message({ children }: { children: React.ReactNode }) { return <div className="flex min-h-48 items-center justify-center gap-2 text-center text-[12px] text-[var(--ink-3)]">{children}</div>; }
