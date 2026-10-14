"use client";

/**
 * The furniture every admin list is made of — search, narrowings, paging and
 * the empty answer — built on HeroUI so the panel looks like one product
 * rather than three screens that each invented a text box.
 *
 * It lives here because Organizations, Users and Errors had grown three
 * copies of the same six components, and a fix to the debounce or the pager
 * only ever landed in one of them.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";
import { X } from "lucide-react";
import {
  Button,
  Label,
  ListBox,
  Pagination,
  SearchField,
  Select,
} from "@heroui/react";
import { EmptyState } from "@/components/ui/empty-state";

/** Long enough that a typed word travels as one question, short enough that
 *  the answer feels like it belongs to the typing. */
const SEARCH_DEBOUNCE_MS = 350;

export type ListNav = (patch: Record<string, string>) => void;

/**
 * Filters live in the URL, so a view an operator is looking at survives a
 * reload and travels as a link.
 */
export function useListNav(): ListNav {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();

  return useCallback(
    (patch: Record<string, string>) => {
      const next = new URLSearchParams(search.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === "") next.delete(key);
        else next.set(key, value);
      }
      // Changing the question restarts the answer at the top: page four of a
      // result set that now has two pages is an empty table, which an
      // operator reads as "nothing matches".
      if (!("offset" in patch)) next.delete("offset");
      const qs = next.toString();
      router.push((qs ? `${pathname}?${qs}` : pathname) as Route, {
        scroll: false,
      });
    },
    [pathname, router, search],
  );
}

/**
 * The search box, which reaches the URL a pause after the typing rather than
 * on every keystroke: the query travels to the API, and a request per
 * character asks six questions to show the answer to one.
 *
 * The draft is local so the caret survives the round trip the search itself
 * started, and follows the URL only when the URL moved on its own — Clear,
 * the back button — which is what the ref distinguishes.
 */
export function ListSearch({
  value,
  onSearch,
  label,
  placeholder,
}: {
  value: string;
  onSearch: (value: string) => void;
  label: string;
  placeholder: string;
}) {
  const [draft, setDraft] = useState(value);
  const submitted = useRef(value);

  useEffect(() => {
    if (value === submitted.current) return;
    submitted.current = value;
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (draft === submitted.current) return;
    const timer = setTimeout(() => {
      submitted.current = draft;
      onSearch(draft);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, onSearch]);

  return (
    <SearchField
      aria-label={label}
      value={draft}
      onChange={setDraft}
      variant="secondary"
      className="min-w-56 flex-1"
    >
      <SearchField.Group>
        <SearchField.SearchIcon />
        <SearchField.Input placeholder={placeholder} />
        <SearchField.ClearButton />
      </SearchField.Group>
    </SearchField>
  );
}

/**
 * A narrowing that reads as its own value: the chosen plan or state is the
 * text on the control, so an operator can see what is hiding rows without
 * opening anything.
 *
 * The empty string is the "all" option and cannot be a React Aria key — an
 * empty key selects nothing — so it travels as a sentinel and is unpacked on
 * the way out.
 */
const ALL = "__all__";

export function ListFilter({
  label,
  value,
  onChange,
  items,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  items: Array<{ id: string; label: string }>;
}) {
  return (
    <Select
      aria-label={label}
      variant="secondary"
      className="w-44 shrink-0"
      selectedKey={value === "" ? ALL : value}
      onSelectionChange={(key) =>
        onChange(key === ALL || key === null ? "" : String(key))
      }
    >
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {items.map((item) => (
            <ListBox.Item
              key={item.id || ALL}
              id={item.id || ALL}
              textValue={item.label}
            >
              <Label>{item.label}</Label>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

/** Undo every narrowing at once. Shown only when there is something to undo,
 *  so the row does not carry a permanently dead control. */
export function ClearFilters({ onPress }: { onPress: () => void }) {
  return (
    <Button variant="ghost" size="sm" onPress={onPress} className="shrink-0">
      <X size={13} /> Clear
    </Button>
  );
}

/**
 * Which slice of the answer this is. Absent whenever the whole answer fits on
 * one page — a pager under fifty of fifty rows is a control that can never be
 * pressed.
 *
 * Page numbers are drawn around the current one rather than all of them: two
 * hundred customers is four pages, twenty thousand is four hundred, and a row
 * of four hundred links is not navigation.
 */
export function ListPager({
  total,
  limit,
  offset,
  go,
}: {
  total: number;
  limit: number;
  offset: number;
  go: ListNav;
}) {
  if (total <= limit) return null;

  const pages = Math.ceil(total / limit);
  const current = Math.floor(offset / limit) + 1;
  const first = offset + 1;
  const last = Math.min(offset + limit, total);
  const to = (page: number) => {
    const next = (page - 1) * limit;
    go({ offset: next > 0 ? String(next) : "" });
  };

  return (
    <Pagination size="sm" className="mt-3 justify-between gap-3">
      <Pagination.Summary className="tabular-nums">
        {first.toLocaleString("en-US")}–{last.toLocaleString("en-US")} of{" "}
        {total.toLocaleString("en-US")}
      </Pagination.Summary>
      <Pagination.Content>
        <Pagination.Item>
          <Pagination.Previous
            isDisabled={current === 1}
            onPress={() => to(current - 1)}
          >
            <Pagination.PreviousIcon />
          </Pagination.Previous>
        </Pagination.Item>
        {pageWindow(current, pages).map((page, i) =>
          page === null ? (
            <Pagination.Item key={`gap-${i}`}>
              <Pagination.Ellipsis />
            </Pagination.Item>
          ) : (
            <Pagination.Item key={page}>
              <Pagination.Link
                isActive={page === current}
                onPress={() => to(page)}
              >
                {page}
              </Pagination.Link>
            </Pagination.Item>
          ),
        )}
        <Pagination.Item>
          <Pagination.Next
            isDisabled={current === pages}
            onPress={() => to(current + 1)}
          >
            <Pagination.NextIcon />
          </Pagination.Next>
        </Pagination.Item>
      </Pagination.Content>
    </Pagination>
  );
}

/** First, last and the neighbours of the current page; `null` is a gap. */
function pageWindow(current: number, pages: number): Array<number | null> {
  if (pages <= 7) {
    return Array.from({ length: pages }, (_, i) => i + 1);
  }
  const around = [current - 1, current, current + 1].filter(
    (p) => p > 1 && p < pages,
  );
  const out: Array<number | null> = [1];
  if (around[0] !== undefined && around[0] > 2) out.push(null);
  out.push(...around);
  const lastAround = around[around.length - 1];
  if (lastAround !== undefined && lastAround < pages - 1) out.push(null);
  out.push(pages);
  return out;
}

/**
 * The answer that has no rows. It says which of the two silences this is —
 * nothing exists yet, or nothing matches what you asked — because the fix is
 * different, and hands over the one control that resolves the second.
 */
export function NoRows({
  title,
  description,
  onClear,
}: {
  title: string;
  description?: string;
  onClear?: () => void;
}) {
  return (
    <EmptyState size="sm" className="mt-4">
      <EmptyState.Header>
        <EmptyState.Title>{title}</EmptyState.Title>
        {description ? (
          <EmptyState.Description>{description}</EmptyState.Description>
        ) : null}
      </EmptyState.Header>
      {onClear ? (
        <EmptyState.Content>
          <Button variant="outline" size="sm" onPress={onClear}>
            <X size={13} /> Clear filters
          </Button>
        </EmptyState.Content>
      ) : null}
    </EmptyState>
  );
}
