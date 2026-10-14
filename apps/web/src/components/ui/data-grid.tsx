"use client";

/**
 * DataGrid — a column-definition driven table on top of HeroUI's `Table`
 * (React Aria under the hood), used by `data-node-view.tsx` to page through a
 * dataset's rows.
 *
 * Only what that view needs: header/cell renderers per column, a row header,
 * controlled or uncontrolled sorting with the chevron indicator, optional
 * column resizing, per-column alignment and an empty state. When
 * `sortDescriptor` is passed the grid never reorders rows itself — the caller
 * sorts server-side and an unsorted local page must not pretend otherwise.
 */
import { useMemo, useState, type ReactNode } from "react";
import { Table } from "@heroui/react";
import type { Key, SortDescriptor } from "react-aria-components";
import { ChevronUp } from "lucide-react";
import { cn } from "@bcontext-dev/contract/utils";

export type DataGridSortDescriptor = SortDescriptor;

export interface DataGridColumn<T> {
  id: string;
  header?: ReactNode | ((state: { sortDirection?: SortDescriptor["direction"] }) => ReactNode);
  /** Renders the cell; without it the grid prints `row[accessorKey]`. */
  cell?: (row: T, column: DataGridColumn<T>) => ReactNode;
  accessorKey?: keyof T & string;
  /** Local comparator for uncontrolled sorting. */
  sortFn?: (a: T, b: T) => number;
  isRowHeader?: boolean;
  allowsSorting?: boolean;
  allowsResizing?: boolean;
  width?: number | `${number}%` | `${number}fr`;
  minWidth?: number;
  maxWidth?: number;
  align?: "start" | "center" | "end";
  cellClassName?: string;
  headerClassName?: string;
}

export interface DataGridProps<T> {
  "aria-label": string;
  columns: DataGridColumn<T>[];
  data: T[];
  getRowId: (row: T) => Key;
  allowsColumnResize?: boolean;
  sortDescriptor?: SortDescriptor;
  defaultSortDescriptor?: SortDescriptor;
  onSortChange?: (descriptor: SortDescriptor) => void;
  onRowAction?: (key: Key) => void;
  renderEmptyState?: () => ReactNode;
  className?: string;
  contentClassName?: string;
  scrollContainerClassName?: string;
  variant?: "primary" | "secondary";
}

const ALIGN: Record<NonNullable<DataGridColumn<unknown>["align"]>, string> = {
  start: "text-start",
  center: "text-center",
  end: "text-end",
};

function compare<T>(a: T, b: T, column: DataGridColumn<T>): number {
  if (column.sortFn) return column.sortFn(a, b);
  const key = column.accessorKey;
  if (!key) return 0;
  const left = a[key];
  const right = b[key];
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left ?? "").localeCompare(String(right ?? ""));
}

export function DataGrid<T extends object>({
  "aria-label": ariaLabel,
  columns,
  data,
  getRowId,
  allowsColumnResize = false,
  sortDescriptor,
  defaultSortDescriptor,
  onSortChange,
  onRowAction,
  renderEmptyState,
  className,
  contentClassName,
  scrollContainerClassName,
  variant = "primary",
}: DataGridProps<T>) {
  const [localSort, setLocalSort] = useState(defaultSortDescriptor);
  const controlled = sortDescriptor !== undefined;
  const sort = controlled ? sortDescriptor : localSort;
  const sortable = columns.some((column) => column.allowsSorting);

  const rows = useMemo(() => {
    if (controlled || !sort?.column) return data;
    const column = columns.find((candidate) => candidate.id === sort.column);
    if (!column) return data;
    const sign = sort.direction === "descending" ? -1 : 1;
    return [...data].sort((a, b) => compare(a, b, column) * sign);
  }, [columns, controlled, data, sort]);

  const content = (
    <Table.Content
      aria-label={ariaLabel}
      className={contentClassName}
      sortDescriptor={sort}
      onRowAction={onRowAction}
      onSortChange={
        sortable
          ? (next) => {
              if (!controlled) setLocalSort(next);
              onSortChange?.(next);
            }
          : undefined
      }
    >
      <Table.Header>
        {columns.map((column) => {
          const resizer = allowsColumnResize && column.allowsResizing !== false ? <Table.ColumnResizer /> : null;
          return (
            <Table.Column
              key={column.id}
              id={column.id}
              isRowHeader={column.isRowHeader}
              allowsSorting={column.allowsSorting}
              width={column.width}
              minWidth={column.minWidth}
              maxWidth={column.maxWidth}
              data-align={column.align}
              className={cn(column.align && ALIGN[column.align], column.headerClassName)}
            >
              {({ sortDirection }) => {
                const label = typeof column.header === "function" ? column.header({ sortDirection }) : column.header;
                return (
                  <>
                    {column.allowsSorting ? (
                      <span data-slot="data-grid-sort-header" className="inline-flex min-w-0 items-center gap-1">
                        {label}
                        {sortDirection ? (
                          <ChevronUp
                            aria-hidden
                            data-direction={sortDirection}
                            className="size-3 shrink-0 transition-transform duration-100 ease-out motion-reduce:transition-none data-[direction=descending]:rotate-180"
                          />
                        ) : null}
                      </span>
                    ) : (
                      label
                    )}
                    {resizer}
                  </>
                );
              }}
            </Table.Column>
          );
        })}
      </Table.Header>
      <Table.Body
        renderEmptyState={
          renderEmptyState
            ? () => (
                <div data-slot="data-grid-empty-state" className="flex items-center justify-center py-12 text-center text-sm text-muted">
                  {renderEmptyState()}
                </div>
              )
            : undefined
        }
      >
        <Table.Collection items={rows} dependencies={[columns]}>
          {(row) => (
            <Table.Row id={getRowId(row)}>
              {columns.map((column) => {
                let value: ReactNode = null;
                if (column.cell) value = column.cell(row, column);
                else if (column.accessorKey) {
                  const raw = row[column.accessorKey];
                  value = raw == null ? "" : String(raw);
                }
                return (
                  <Table.Cell
                    key={column.id}
                    data-align={column.align}
                    className={cn("align-middle", column.align && ALIGN[column.align], column.cellClassName)}
                  >
                    {value}
                  </Table.Cell>
                );
              })}
            </Table.Row>
          )}
        </Table.Collection>
      </Table.Body>
    </Table.Content>
  );

  return (
    <Table data-slot="data-grid" variant={variant} className={cn("relative w-full", className)}>
      <Table.ScrollContainer className={scrollContainerClassName}>
        {allowsColumnResize ? <Table.ResizableContainer>{content}</Table.ResizableContainer> : content}
      </Table.ScrollContainer>
    </Table>
  );
}
