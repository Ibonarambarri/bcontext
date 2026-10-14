/**
 * Pure logic behind the saved list renderer (saved-list-view.tsx): the
 * session filters the Filter panel applies CLIENT-SIDE over the rows the
 * resolver already returned, and the default ordering. Kept out of the
 * component so both are unit-testable without a DOM.
 */
import type { KnowledgeNode, NodeKind, NodeStatus } from "@bcontext-dev/contract/types";
import type { ViewPresentation } from "@bcontext-dev/contract/views/schema";

export interface ListSessionFilters {
  kind: "" | NodeKind;
  status: "" | NodeStatus;
  /** Tag id (not name) — chips and rows always carry ids. */
  tag: string;
  /** "YYYY-MM-DD" bounds over updated_at, inclusive. */
  from: string;
  to: string;
}

export const EMPTY_LIST_FILTERS: ListSessionFilters = { kind: "", status: "", tag: "", from: "", to: "" };

export function countActiveListFilters(filters: ListSessionFilters): number {
  return Object.values(filters).filter((value) => value !== "").length;
}

export function applyListSessionFilters<T extends Pick<KnowledgeNode, "kind" | "status" | "tags" | "updated_at">>(
  nodes: T[],
  filters: ListSessionFilters,
): T[] {
  const from = filters.from ? `${filters.from}T00:00:00.000Z` : null;
  const to = filters.to ? `${filters.to}T23:59:59.999Z` : null;
  return nodes.filter((node) =>
    (!filters.kind || node.kind === filters.kind)
    && (!filters.status || node.status === filters.status)
    && (!filters.tag || node.tags.some((tag) => tag.id === filters.tag))
    && (!from || node.updated_at >= from)
    && (!to || node.updated_at <= to),
  );
}

/**
 * Most recent first unless the view pins its own ordering. ISO-8601
 * timestamps compare correctly as strings, so one localeCompare covers
 * text and date fields alike.
 */
export function sortListNodes<T extends Partial<KnowledgeNode>>(
  nodes: T[],
  sortBy: ViewPresentation["sort_by"],
): T[] {
  const sort = sortBy[0] ?? { field: "updated_at" as const, direction: "desc" as const };
  return [...nodes].sort((a, b) => {
    const comparison = String(a[sort.field] ?? "").localeCompare(String(b[sort.field] ?? ""));
    return sort.direction === "desc" ? -comparison : comparison;
  });
}
