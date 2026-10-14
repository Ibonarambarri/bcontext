"use client";

/**
 * The reading surface for `kind === "data"` nodes: a title and a table.
 *
 * A dataset's rows live in their own table on the server; the node keeps only
 * what IS knowledge — the columns, their types, the row count and a one-line
 * description — in `node.data.dataset`. So this view has no editor: there is
 * no body to edit, and hand-editing a CSV that may be two hundred thousand
 * rows long was never the thing anyone wanted. What is left is the table, and
 * the three questions you ask a table: which page, in what order, matching
 * what.
 *
 * All three are asked of the SERVER, in a `DatasetQuery` (`limit`/`offset`,
 * `order_by`, `where`). Sorting or paging an array the browser downloaded
 * would only move the problem into the tab: a dataset holds up to
 * `DATASET_MAX_ROWS` rows and the page ceiling is `DATASET_QUERY_MAX_LIMIT`.
 *
 * The description stays editable because it is not decoration: it is the only
 * prose of a dataset that reaches the vector index, so it is what makes a
 * table findable by someone searching for "customer data" without knowing
 * what it was called.
 *
 * Three states that look alike and are not, and are drawn differently on
 * purpose:
 *   - **no dataset, CSV still in the body** — every `data` node written before
 *     the rows moved out. It is offered a conversion rather than an error,
 *     doing exactly what the server's migration does: rows first, then the
 *     body.
 *   - **no dataset, empty body** — a node waiting for a table. Drop a CSV.
 *   - **a dataset with `row_count: 0`** — columns, no rows. Not the same thing
 *     as having no dataset, and not spelled the same way.
 * An absent cell reads `—` and never `0`: a missing value and a zero are
 * different facts.
 *
 * Writes (an upload, a conversion, the description) are guarded like every
 * other node write: they send the freshest `updated_at` this view knows as
 * `if_updated_at`, fold the server's node back through `onWritten` (and the
 * workspace overlay) so the next guarded write does not trip over its own
 * save, and on a 409 call `onConflict` so the caller reloads. Without
 * `canWrite` the view is the table and nothing else: no drop target, no
 * upload, no conversion, the description read-only.
 *
 * Reached through `lazy-node-body.tsx` on the node page and through
 * `node-panel/panel-body.tsx` in the floating panel.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DataGrid, type DataGridColumn, type DataGridSortDescriptor } from "@/components/ui/data-grid";
import { DropZone } from "@/components/ui/drop-zone";
import { EmptyState } from "@/components/ui/empty-state";
import { Button, Chip, Input, ListBox, Popover, Select, TextField, Tooltip } from "@heroui/react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileSpreadsheet,
  Filter as FilterIcon,
  Loader2,
  Table2,
  Upload,
  X,
} from "lucide-react";
import {
  DATASET_QUERY_DEFAULT_LIMIT,
  type ColumnType,
  type DatasetColumn,
  type DatasetOperator,
} from "@bcontext-dev/contract/datasets";
import { cn } from "@bcontext-dev/contract/utils";
import { useToast, useWorkspace } from "@/components/workspace-context";
import { newestUpdatedAt } from "@/lib/newest-updated-at";
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import {
  DatasetRequestError,
  OPERATOR_LABELS,
  buildDatasetQuery,
  cellText,
  convertLegacyNode,
  datasetFromNodeData,
  extractLegacyCsv,
  fetchDatasetRows,
  fetchDatasetView,
  fetchSourceFileUrl,
  filterIsActive,
  formatBytes,
  formatCount,
  ingestCsv,
  isConflict,
  isMissingDataset,
  operatorTakesValue,
  operatorsFor,
  saveDescription,
  type DatasetRowsPage,
  type DatasetView,
  type LegacyCsv,
} from "@/lib/datasets";
import { type WorkspaceAddress } from "@/web/workspace-url";

/** Page sizes the footer offers. The ceiling is the contract's, not ours. */
const PAGE_SIZES = [50, DATASET_QUERY_DEFAULT_LIMIT, 250, 500] as const;

/** How a column's type is written in its header — three letters, muted. */
const TYPE_LABEL: Record<ColumnType, string> = {
  text: "txt",
  number: "num",
  boolean: "bool",
  date: "date",
};

interface GridRow extends Record<string, unknown> {
  /** Rows carry no id of their own; their position in the page is one. */
  __at: number;
}

type ActiveFilter = { column: string; op: DatasetOperator; value: string };

type Stage =
  | { kind: "loading" }
  | { kind: "ready"; dataset: DatasetView }
  | { kind: "absent" }
  | { kind: "error"; message: string };

function errorMessage(err: unknown): string {
  if (err instanceof DatasetRequestError) return err.message;
  return err instanceof Error ? err.message : "Something went wrong.";
}

/* -- dropping a file on the node -------------------------------------------- */

/**
 * Dragging a CSV anywhere onto the view is the human path into a dataset (the
 * agent's is the MCP tool and never comes through here), so the drop target is
 * the whole surface rather than a box you have to aim at. The counter is what
 * makes it stable: `dragleave` fires for every child the pointer crosses.
 */
function useFileDrop(onFile: (file: File) => void, disabled: boolean) {
  const depth = useRef(0);
  const [over, setOver] = useState(false);

  const reset = useCallback(() => {
    depth.current = 0;
    setOver(false);
  }, []);

  return {
    isOver: over && !disabled,
    handlers: {
      onDragEnter: (event: React.DragEvent) => {
        if (disabled || !event.dataTransfer?.types.includes("Files")) return;
        event.preventDefault();
        depth.current += 1;
        setOver(true);
      },
      onDragOver: (event: React.DragEvent) => {
        if (disabled || !event.dataTransfer?.types.includes("Files")) return;
        event.preventDefault();
      },
      onDragLeave: () => {
        depth.current -= 1;
        if (depth.current <= 0) reset();
      },
      onDrop: (event: React.DragEvent) => {
        if (disabled) return;
        const file = event.dataTransfer?.files?.[0];
        if (!file) return;
        event.preventDefault();
        reset();
        onFile(file);
      },
    },
  };
}

/* -- pieces ----------------------------------------------------------------- */

/** The one line of prose a dataset has, and the only one search can see. */
function DescriptionLine({
  value,
  saving,
  readOnly,
  onSave,
}: {
  value: string | null;
  saving: boolean;
  readOnly: boolean;
  onSave: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");

  if (readOnly) {
    return value ? (
      <p className="max-w-full truncate py-1 text-[13px] leading-relaxed text-[var(--ink-2)]">{value}</p>
    ) : null;
  }

  if (!editing) {
    return (
      <button
        type="button"
        disabled={saving}
        onClick={() => {
          setDraft(value ?? "");
          setEditing(true);
        }}
        className={cn(
          "-mx-1.5 max-w-full truncate rounded-md px-1.5 py-1 text-left text-[13px] leading-relaxed hover:bg-[var(--paper-3)]",
          value ? "text-[var(--ink-2)]" : "text-[var(--ink-mute)]",
        )}
      >
        {value || "Add a one-line description — it is how this table gets found."}
      </button>
    );
  }

  const commit = () => {
    setEditing(false);
    if (draft.trim() !== (value ?? "").trim()) onSave(draft);
  };

  return (
    <TextField aria-label="Dataset description" value={draft} onChange={setDraft} className="w-full">
      <Input
        autoFocus
        placeholder="What is in this table?"
        className="text-[13px]"
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") {
            setDraft(value ?? "");
            setEditing(false);
          }
        }}
      />
    </TextField>
  );
}

function MiniSelect({
  label,
  value,
  options,
  disabled,
  onChange,
  className,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <Select
      aria-label={label}
      isDisabled={disabled}
      value={value}
      onChange={(key) => onChange(key == null ? "" : String(key))}
      className={cn("min-w-0", className)}
    >
      <Select.Trigger className="inline-flex h-7 max-w-full items-center gap-1.5 overflow-hidden rounded-md border border-[var(--line)] bg-[var(--paper)] py-0 pl-2 pr-1.5 text-[11.5px] leading-none text-[var(--ink)] hover:border-[var(--line-strong)]">
        <Select.Value className="min-w-0 truncate" />
        <Select.Indicator className="shrink-0 opacity-60" />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {options.map((option) => (
            <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
              <span className="truncate">{option.label}</span>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

/**
 * One filter, in a popover, with the active one shown as a chip beside it.
 *
 * One clause rather than a builder because the operators offered depend on the
 * column's type — the server refuses `contains` on a number and a range on a
 * boolean — and a single well-typed question answers most of them.
 */
function FilterControl({
  columns,
  filter,
  disabled,
  onChange,
}: {
  columns: DatasetColumn[];
  filter: ActiveFilter | null;
  disabled: boolean;
  onChange: (next: ActiveFilter | null) => void;
}) {
  const active = filterIsActive(filter);
  const column = columns.find((item) => item.name === filter?.column) ?? columns[0]!;
  const operators = operatorsFor(column.type);
  const current: ActiveFilter = filter ?? { column: column.name, op: operators[0]!, value: "" };

  const setColumn = (name: string) => {
    const next = columns.find((item) => item.name === name);
    if (!next) return;
    const allowed = operatorsFor(next.type);
    onChange({
      column: next.name,
      op: allowed.includes(current.op) ? current.op : allowed[0]!,
      value: current.value,
    });
  };

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {active && filter ? (
        <Chip size="sm" variant="soft" className="min-w-0 gap-1 pr-1 text-[10.5px]">
          <Chip.Label className="truncate">
            {filter.column} {OPERATOR_LABELS[filter.op]}
            {operatorTakesValue(filter.op) ? ` ${filter.value}` : ""}
          </Chip.Label>
          <button
            type="button"
            aria-label="Clear the filter"
            onClick={() => onChange(null)}
            className="rounded p-0.5 text-[var(--ink-mute)] hover:text-[var(--ink)]"
          >
            <X size={10} />
          </button>
        </Chip>
      ) : null}
      <Popover>
        <Button
          size="sm"
          variant="ghost"
          isDisabled={disabled}
          aria-label="Filter rows"
          className="icon-btn"
        >
          <FilterIcon size={13} className={active ? "text-[var(--ink)]" : "text-[var(--ink-3)]"} />
        </Button>
        <Popover.Content placement="bottom end" className="w-[290px]">
          <Popover.Dialog className="p-3">
            <Popover.Heading className="mono text-[10px] uppercase tracking-[0.08em] text-[var(--ink-mute)]">
              Filter
            </Popover.Heading>
            <div className="mt-2 flex flex-col gap-2">
              <MiniSelect
                label="Column"
                value={current.column}
                onChange={setColumn}
                options={columns.map((item) => ({
                  value: item.name,
                  label: `${item.name} · ${TYPE_LABEL[item.type]}`,
                }))}
              />
              <MiniSelect
                label="Operator"
                value={current.op}
                onChange={(op) => onChange({ ...current, op: op as DatasetOperator })}
                options={operators.map((op) => ({ value: op, label: OPERATOR_LABELS[op] }))}
              />
              {operatorTakesValue(current.op) ? (
                column.type === "boolean" ? (
                  <MiniSelect
                    label="Value"
                    value={current.value || "true"}
                    onChange={(value) => onChange({ ...current, value })}
                    options={[
                      { value: "true", label: "true" },
                      { value: "false", label: "false" },
                    ]}
                  />
                ) : (
                  <TextField
                    aria-label="Value"
                    value={current.value}
                    onChange={(value) => onChange({ ...current, value })}
                  >
                    <Input
                      placeholder={column.type === "date" ? "2026-01-31" : "Value"}
                      className="mono h-7 text-[11.5px]"
                    />
                  </TextField>
                )
              ) : null}
              {active ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() => onChange(null)}
                  className="self-start text-[11px] text-[var(--ink-3)]"
                >
                  Clear
                </Button>
              ) : null}
            </div>
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
    </div>
  );
}

/**
 * Which rows are on screen, and how to get to the next ones.
 *
 * With a filter on, the total is unknowable without counting the matches, and
 * the server does not: `row_count` is the whole dataset. So a filtered footer
 * says the range it is showing and nothing it cannot prove, and "next" follows
 * `truncated` — the page came back full, so there may be more.
 */
function Pager({
  page,
  total,
  filtered,
  limit,
  busy,
  compact,
  onOffset,
  onLimit,
}: {
  page: DatasetRowsPage | null;
  total: number;
  filtered: boolean;
  limit: number;
  busy: boolean;
  compact: boolean;
  onOffset: (next: number) => void;
  onLimit: (next: number) => void;
}) {
  const offset = page?.offset ?? 0;
  const shown = page?.rows.length ?? 0;
  const from = shown === 0 ? 0 : offset + 1;
  const to = offset + shown;
  const hasNext = filtered ? Boolean(page?.truncated) : to < total;
  const hasPrev = offset > 0;
  if (!hasPrev && !hasNext && compact) {
    return (
      <span className="mono text-[10px] text-[var(--ink-mute)]">
        {filtered ? `${formatCount(shown)} matching` : `${formatCount(total)} rows`}
      </span>
    );
  }

  return (
    <div className="flex items-center justify-between gap-2">
      <span className="mono truncate text-[10px] tabular-nums text-[var(--ink-mute)]">
        {shown === 0
          ? "No rows"
          : filtered
            ? `Rows ${formatCount(from)}–${formatCount(to)}`
            : `${formatCount(from)}–${formatCount(to)} of ${formatCount(total)}`}
      </span>
      <div className="flex shrink-0 items-center gap-1.5">
        {!compact ? (
          <MiniSelect
            label="Rows per page"
            value={String(limit)}
            disabled={busy}
            onChange={(value) => onLimit(Number(value))}
            options={PAGE_SIZES.map((size) => ({ value: String(size), label: `${size} / page` }))}
          />
        ) : null}
        <Tooltip delay={500}>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label="Previous page"
            isDisabled={!hasPrev || busy}
            onPress={() => onOffset(Math.max(0, offset - limit))}
            className="icon-btn"
          >
            <ChevronLeft size={13} />
          </Button>
          <Tooltip.Content>Previous page</Tooltip.Content>
        </Tooltip>
        <Tooltip delay={500}>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label="Next page"
            isDisabled={!hasNext || busy}
            onPress={() => onOffset(offset + limit)}
            className="icon-btn"
          >
            <ChevronRight size={13} />
          </Button>
          <Tooltip.Content>Next page</Tooltip.Content>
        </Tooltip>
      </div>
    </div>
  );
}

/** The invitation for a `data` node that has no table yet. */
function DropCsvState({
  compact,
  busy,
  onFile,
}: {
  compact: boolean;
  busy: boolean;
  onFile: (file: File) => void;
}) {
  return (
    <DropZone className="w-full">
      <DropZone.Area
        isDisabled={busy}
        onDrop={async (event) => {
          for (const item of event.items) {
            if (item.kind === "file") {
              onFile(await item.getFile());
              return;
            }
          }
        }}
      >
        <DropZone.Icon>
          <FileSpreadsheet />
        </DropZone.Icon>
        <DropZone.Label>{busy ? "Reading the file…" : "Drop a CSV here"}</DropZone.Label>
        <DropZone.Description>
          The header row becomes the columns, and their types are read from the values.
        </DropZone.Description>
        <DropZone.Trigger>{compact ? "Choose" : "Choose a file"}</DropZone.Trigger>
      </DropZone.Area>
      <DropZone.Input
        accept=".csv,text/csv"
        onSelect={(files) => {
          const file = files.item(0);
          if (file) onFile(file);
        }}
      />
    </DropZone>
  );
}

/* -- the view --------------------------------------------------------------- */

export interface DataNodeViewProps {
  workspace: WorkspaceAddress;
  nodeId: string;
  /** The body. Only read to spot the ```csv block a legacy `data` node still carries. */
  initialMarkdown: string;
  /** `node.data`, so a dataset paints without waiting for a round-trip. */
  initialData?: Record<string, unknown>;
  header?: React.ReactNode;
  /** Compact rendering for the floating node panel — smaller chrome, capped height. */
  compact?: boolean;
  /** The node's `updated_at` as rendered — the optimistic lock's fallback seed. */
  initialUpdatedAt?: string;
  canWrite?: boolean;
  /** The server's node after a confirmed write, for a parent that keeps its own copy. */
  onWritten?: (node: KnowledgeNode) => void;
  /** Someone else wrote first; the caller should reload the node. */
  onConflict?: () => void;
}

export function DataNodeView({
  workspace,
  nodeId,
  initialMarkdown,
  initialData,
  header,
  compact = false,
  initialUpdatedAt,
  canWrite = true,
  onWritten,
  onConflict,
}: DataNodeViewProps) {
  const toast = useToast();
  const { nodes, patchNodeSummary } = useWorkspace();
  const { org, slug } = workspace;
  const address = useMemo<WorkspaceAddress>(() => ({ org, slug }), [org, slug]);

  const seeded = useMemo(() => datasetFromNodeData(initialData), [initialData]);
  const [stage, setStage] = useState<Stage>(() =>
    seeded ? { kind: "ready", dataset: seeded } : { kind: "loading" },
  );
  const [nodeData, setNodeData] = useState<Record<string, unknown>>(initialData ?? {});
  const [body, setBody] = useState(initialMarkdown);
  const legacy = useMemo<LegacyCsv | null>(() => extractLegacyCsv(body), [body]);

  const [page, setPage] = useState<DatasetRowsPage | null>(null);
  const [rowsError, setRowsError] = useState<string | null>(null);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [limit, setLimit] = useState<number>(compact ? 50 : DATASET_QUERY_DEFAULT_LIMIT);
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<{ column: string; direction: "asc" | "desc" } | null>(null);
  const [filter, setFilter] = useState<ActiveFilter | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [savingDescription, setSavingDescription] = useState(false);

  const dataset = stage.kind === "ready" ? stage.dataset : null;
  const rowCount = dataset?.rowCount ?? 0;

  const [seenUpdatedAt, setSeenUpdatedAt] = useState(initialUpdatedAt);
  const updatedAt = newestUpdatedAt(
    nodes.find((candidate) => candidate.id === nodeId)?.updated_at,
    initialUpdatedAt,
    seenUpdatedAt,
  );

  // A newer render of the node (the panel reloaded after a peer's write)
  // replaces what this view holds unless a write of its own is in flight;
  // keyed on `updated_at` so a stale page prop never undoes a confirmed save.
  const syncedRef = useRef(initialUpdatedAt);
  useEffect(() => {
    if (initialUpdatedAt === syncedRef.current || busy !== null || savingDescription) return;
    syncedRef.current = initialUpdatedAt;
    setNodeData(initialData ?? {});
    setBody(initialMarkdown);
    setStage(seeded ? { kind: "ready", dataset: seeded } : { kind: "loading" });
    setRevision((value) => value + 1);
  }, [initialUpdatedAt, initialData, initialMarkdown, seeded, busy, savingDescription]);

  /** A confirmed write: remember its `updated_at` and tell whoever keeps a copy. */
  const fold = useCallback(
    (node: KnowledgeNode | null) => {
      if (!node) return;
      setSeenUpdatedAt(node.updated_at);
      syncedRef.current = node.updated_at;
      patchNodeSummary(node.id, { data: node.data, updated_at: node.updated_at });
      onWritten?.(node);
    },
    [patchNodeSummary, onWritten],
  );

  /** A refused write: a conflict is the caller's to reload; anything else is said. */
  const failed = useCallback(
    (err: unknown) => {
      if (isConflict(err)) {
        toast.error("This table changed elsewhere. Reloaded — try again.");
        onConflict?.();
        return;
      }
      toast.error(errorMessage(err));
    },
    [toast, onConflict],
  );

  // The shape. Only fetched when the node payload did not already carry it —
  // which is exactly the legacy case, and the one where the answer matters.
  useEffect(() => {
    if (stage.kind !== "loading") return;
    let alive = true;
    fetchDatasetView(address, nodeId)
      .then((view) => {
        if (alive) setStage({ kind: "ready", dataset: view });
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setStage(isMissingDataset(err) ? { kind: "absent" } : { kind: "error", message: errorMessage(err) });
      });
    return () => {
      alive = false;
    };
  }, [stage.kind, address, nodeId]);

  // The rows. Every page, ordering and filter is a question for the server.
  useEffect(() => {
    if (!dataset || rowCount === 0) {
      setPage(null);
      return;
    }
    let alive = true;
    setRowsLoading(true);
    fetchDatasetRows(address, nodeId, buildDatasetQuery({ limit, offset, sort, filter }))
      .then((next) => {
        if (!alive) return;
        setPage(next);
        setRowsError(null);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setPage(null);
        setRowsError(errorMessage(err));
      })
      .finally(() => {
        if (alive) setRowsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [dataset, rowCount, address, nodeId, limit, offset, sort, filter, revision]);

  const applySort = (descriptor: DataGridSortDescriptor) => {
    const column = String(descriptor.column ?? "");
    setOffset(0);
    setSort(column ? { column, direction: descriptor.direction === "descending" ? "desc" : "asc" } : null);
  };

  const applyFilter = (next: ActiveFilter | null) => {
    setOffset(0);
    setFilter(next);
  };

  const readCsv = useCallback(
    async (file: File, label: string, run: (csv: string) => Promise<void>) => {
      if (!/\.(csv|txt)$/i.test(file.name) && file.type !== "text/csv") {
        toast.error("Datasets read CSV. Export the sheet as CSV and drop it again.");
        return;
      }
      setBusy(label);
      try {
        await run(await file.text());
      } catch (err) {
        failed(err);
      } finally {
        setBusy(null);
      }
    },
    [toast, failed],
  );

  const uploadCsv = useCallback(
    (file: File) =>
      void readCsv(file, "Uploading…", async (csv) => {
        const result = await ingestCsv(address, nodeId, csv, { ifUpdatedAt: updatedAt });
        fold(result.node);
        setNodeData(result.data);
        if (result.dataset) setStage({ kind: "ready", dataset: result.dataset });
        setOffset(0);
        setFilter(null);
        setSort(null);
        setRevision((value) => value + 1);
        toast.info(`${formatCount(result.rowsWritten)} rows are in.`);
      }),
    [address, nodeId, readCsv, toast, updatedAt, fold],
  );

  const convert = useCallback(() => {
    if (!legacy) return;
    setBusy("Converting…");
    void (async () => {
      try {
        const result = await convertLegacyNode(address, nodeId, legacy, updatedAt);
        fold(result.node);
        setNodeData(result.data);
        setBody(legacy.remainder);
        if (result.dataset) setStage({ kind: "ready", dataset: result.dataset });
        setRevision((value) => value + 1);
        toast.info(`${formatCount(result.rowsWritten)} rows lifted out of the body.`);
      } catch (err) {
        failed(err);
      } finally {
        setBusy(null);
      }
    })();
  }, [address, nodeId, legacy, toast, updatedAt, fold, failed]);

  const persistDescription = useCallback(
    (next: string) => {
      const previous = nodeData;
      // Optimistic: the line is already what it will be, and a failure says so
      // and puts the old one back.
      setNodeData({ ...nodeData, description: next.trim() || undefined });
      setStage((current) =>
        current.kind === "ready"
          ? { kind: "ready", dataset: { ...current.dataset, description: next.trim() || null } }
          : current,
      );
      setSavingDescription(true);
      void saveDescription(address, nodeId, previous, next, updatedAt)
        .then((saved) => {
          setNodeData(saved.data);
          fold(saved.node);
        })
        .catch((err: unknown) => {
          setNodeData(previous);
          setStage((current) =>
            current.kind === "ready"
              ? {
                  kind: "ready",
                  dataset: {
                    ...current.dataset,
                    description: typeof previous.description === "string" ? previous.description : null,
                  },
                }
              : current,
          );
          failed(err);
        })
        .finally(() => setSavingDescription(false));
    },
    [address, nodeId, nodeData, updatedAt, fold, failed],
  );

  const downloadSource = useCallback(() => {
    void (async () => {
      try {
        const url = await fetchSourceFileUrl(address, nodeId);
        if (url) window.open(url, "_blank", "noopener,noreferrer");
        else toast.error("That file is no longer stored.");
      } catch (err) {
        toast.error(errorMessage(err));
      }
    })();
  }, [address, nodeId, toast]);

  const picker = useRef<HTMLInputElement | null>(null);

  // The whole surface is the drop target — EXCEPT where the hero drop zone is
  // already one. Two listeners over the same pixels means one file read twice.
  const heroDropZone =
    stage.kind === "absent" ? legacy === null : stage.kind === "ready" && rowCount === 0;
  const drop = useFileDrop(uploadCsv, !canWrite || busy !== null || heroDropZone);

  const columns = useMemo<DataGridColumn<GridRow>[]>(() => {
    if (!dataset) return [];
    return dataset.columns.map((column, index) => {
      const numeric = column.type === "number";
      return {
        id: column.name,
        header: (
          <span className="inline-flex min-w-0 items-baseline gap-1.5">
            <span className="truncate">{column.name}</span>
            <span className="mono shrink-0 text-[9px] uppercase tracking-wider text-[var(--ink-mute)]">
              {TYPE_LABEL[column.type]}
            </span>
          </span>
        ),
        cell: (row: GridRow) => {
          const text = cellText(row[column.name]);
          return text === null ? (
            <span className="text-[var(--ink-mute)]" aria-label="No value">
              —
            </span>
          ) : (
            <span className="truncate">{text}</span>
          );
        },
        isRowHeader: index === 0,
        allowsSorting: true,
        allowsResizing: true,
        minWidth: 96,
        align: numeric ? "end" : "start",
        cellClassName: numeric ? "tabular-nums" : undefined,
      } satisfies DataGridColumn<GridRow>;
    });
  }, [dataset]);

  const rows = useMemo<GridRow[]>(
    () => (page?.rows ?? []).map((row, index) => ({ ...row, __at: (page?.offset ?? 0) + index })),
    [page],
  );

  // Controlled sorting, always: an undefined descriptor would hand sorting
  // back to the grid, which would then reorder the one page it can see and
  // call it sorted. An empty column means "file order", which no header claims.
  const sortDescriptor: DataGridSortDescriptor = sort
    ? { column: sort.column, direction: sort.direction === "desc" ? "descending" : "ascending" }
    : { column: "", direction: "ascending" };

  const filtered = filterIsActive(filter);

  let content: React.ReactNode;
  if (stage.kind === "loading") {
    content = <GridPlaceholder compact={compact} label="Reading the table…" />;
  } else if (stage.kind === "error") {
    content = (
      <EmptyState size={compact ? "sm" : "md"}>
        <EmptyState.Header>
          <EmptyState.Media variant="icon">
            <Table2 />
          </EmptyState.Media>
          <EmptyState.Title>This table could not be read</EmptyState.Title>
          <EmptyState.Description>{stage.message}</EmptyState.Description>
        </EmptyState.Header>
        <EmptyState.Content>
          <Button size="sm" variant="outline" onPress={() => setStage({ kind: "loading" })}>
            Try again
          </Button>
        </EmptyState.Content>
      </EmptyState>
    );
  } else if (stage.kind === "absent" && legacy) {
    // The node still keeps its table in the body, the way every `data` node did
    // before the rows moved out. Offer the same move the server's migration
    // makes rather than an error about a dataset that was never created.
    content = (
      <div className="flex flex-col gap-3 rounded-xl border border-[var(--line)] bg-[var(--paper-2)] p-4">
        <div className="flex flex-col gap-1">
          <span className="text-[13px] font-medium text-[var(--ink)]">This table still lives in the body</span>
          <p className="max-w-prose text-[12px] leading-relaxed text-[var(--ink-3)]">
            It was written before datasets had rows of their own, so it is still a{" "}
            <code className="mono text-[11px]">```csv</code> block. Converting reads the header into typed
            columns, moves the {formatCount(Math.max(0, legacy.csv.trim().split(/\r?\n/).length - 1))} rows
            into the dataset and leaves whatever prose surrounded it as the body.
          </p>
        </div>
        {canWrite ? (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="primary" isDisabled={busy !== null} onPress={convert}>
              {busy === "Converting…" ? "Converting…" : "Convert to a dataset"}
            </Button>
            <span className="mono text-[10px] uppercase tracking-wider text-[var(--ink-mute)]">
              Nothing is lost
            </span>
          </div>
        ) : null}
      </div>
    );
  } else if (stage.kind === "absent") {
    content = canWrite ? (
      <DropCsvState compact={compact} busy={busy !== null} onFile={uploadCsv} />
    ) : (
      <EmptyState size={compact ? "sm" : "md"}>
        <EmptyState.Header>
          <EmptyState.Media variant="icon">
            <Table2 />
          </EmptyState.Media>
          <EmptyState.Title>No table yet</EmptyState.Title>
        </EmptyState.Header>
      </EmptyState>
    );
  } else if (rowCount === 0) {
    // A dataset with no rows is not a node without a dataset: the columns are
    // real, they are what an agent reads, and they are what the next upload
    // has to match.
    content = (
      <div className="flex flex-col gap-3">
        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-2)] px-3 py-2.5">
          <span className="mono text-[10px] uppercase tracking-wider text-[var(--ink-mute)]">
            {dataset!.columns.length} columns, no rows yet
          </span>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {dataset!.columns.map((column) => (
              <Chip key={column.name} size="sm" variant="soft" className="gap-1 text-[10.5px]">
                <Chip.Label>{column.name}</Chip.Label>
                <span className="mono text-[9px] uppercase text-[var(--ink-mute)]">
                  {TYPE_LABEL[column.type]}
                </span>
              </Chip>
            ))}
          </div>
        </div>
        {canWrite ? <DropCsvState compact={compact} busy={busy !== null} onFile={uploadCsv} /> : null}
      </div>
    );
  } else if (rowsError) {
    content = (
      <EmptyState size={compact ? "sm" : "md"}>
        <EmptyState.Header>
          <EmptyState.Media variant="icon">
            <FilterIcon />
          </EmptyState.Media>
          <EmptyState.Title>That question came back empty-handed</EmptyState.Title>
          <EmptyState.Description>{rowsError}</EmptyState.Description>
        </EmptyState.Header>
        {filtered ? (
          <EmptyState.Content>
            <Button size="sm" variant="outline" onPress={() => applyFilter(null)}>
              Clear the filter
            </Button>
          </EmptyState.Content>
        ) : null}
      </EmptyState>
    );
  } else if (!page && rowsLoading) {
    content = <GridPlaceholder compact={compact} label="Reading rows…" />;
  } else {
    content = (
      <DataGrid<GridRow>
        aria-label="Dataset rows"
        columns={columns}
        data={rows}
        getRowId={(item) => item.__at}
        allowsColumnResize
        sortDescriptor={sortDescriptor}
        onSortChange={applySort}
        scrollContainerClassName={compact ? "max-h-[46vh] overflow-y-auto" : "max-h-[62vh] overflow-y-auto"}
        className={cn("w-full", rowsLoading ? "opacity-60 transition-opacity" : undefined)}
        renderEmptyState={() => (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <span className="text-[12.5px] text-[var(--ink-3)]">
              {filtered ? "No rows match this filter." : "This page has no rows."}
            </span>
            {filtered ? (
              <Button size="sm" variant="ghost" onPress={() => applyFilter(null)} className="text-[11px]">
                Clear the filter
              </Button>
            ) : null}
          </div>
        )}
      />
    );
  }

  const total = page?.totalRows ?? rowCount;
  const toolbar = dataset ? (
    <div className="flex min-w-0 items-center justify-between gap-2">
      <span className="mono min-w-0 truncate text-[10px] uppercase tracking-wider tabular-nums text-[var(--ink-mute)]">
        {formatCount(total)} rows · {dataset.columns.length} columns
        {busy ? ` · ${busy}` : ""}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        {rowCount > 0 ? (
          <FilterControl
            columns={dataset.columns}
            filter={filter}
            disabled={busy !== null}
            onChange={applyFilter}
          />
        ) : null}
        {dataset.sourceFile ? (
          <Tooltip delay={500}>
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              aria-label={`Download ${dataset.sourceFile.filename}`}
              onPress={downloadSource}
              className="icon-btn"
            >
              <Download size={13} />
            </Button>
            <Tooltip.Content>
              {dataset.sourceFile.filename} · {formatBytes(dataset.sourceFile.bytes)}
            </Tooltip.Content>
          </Tooltip>
        ) : null}
        {canWrite && rowCount > 0 ? (
          <Tooltip delay={500}>
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              aria-label="Replace every row from a CSV"
              isDisabled={busy !== null}
              onPress={() => picker.current?.click()}
              className="icon-btn"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
            </Button>
            <Tooltip.Content>Drop or choose a CSV to replace every row</Tooltip.Content>
          </Tooltip>
        ) : null}
      </div>
    </div>
  ) : null;

  const inner = (
    <div className="relative flex min-w-0 flex-col gap-3" {...drop.handlers}>
      <DescriptionLine
        value={dataset?.description ?? (typeof nodeData.description === "string" ? nodeData.description : null)}
        saving={savingDescription}
        readOnly={!canWrite}
        onSave={persistDescription}
      />
      {toolbar}
      {content}
      {dataset && rowCount > 0 ? (
        <Pager
          page={page}
          total={total}
          filtered={filtered}
          limit={limit}
          busy={busy !== null || rowsLoading}
          compact={compact}
          onOffset={setOffset}
          onLimit={(next) => {
            setOffset(0);
            setLimit(next);
          }}
        />
      ) : null}
      <input
        ref={picker}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) uploadCsv(file);
        }}
      />
      {drop.isOver ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-[var(--line-strong)] bg-[var(--paper)]/85">
          <span className="text-[12.5px] font-medium text-[var(--ink-2)]">
            {rowCount > 0 ? "Drop to replace every row" : "Drop the CSV to build the table"}
          </span>
        </div>
      ) : null}
    </div>
  );

  if (compact) return inner;

  return (
    <div className="scroll relative h-full overflow-y-auto bg-[var(--paper)]">
      <div
        className="mx-auto flex flex-col gap-4"
        style={{
          maxWidth: "var(--edit-max-wide, 1280px)",
          paddingInline: "var(--editor-px)",
          paddingBlock: "var(--editor-py)",
          paddingBottom: "120px",
        }}
      >
        {header}
        {inner}
      </div>
    </div>
  );
}

function GridPlaceholder({ compact, label }: { compact: boolean; label: string }) {
  return (
    <div
      className={cn(
        "flex items-center justify-center gap-2 rounded-xl border border-[var(--line)] bg-[var(--paper-2)]",
        compact ? "h-32" : "h-48",
      )}
    >
      <Loader2 size={13} className="animate-spin text-[var(--ink-mute)]" />
      <span className="text-[12px] text-[var(--ink-3)]">{label}</span>
    </div>
  );
}
