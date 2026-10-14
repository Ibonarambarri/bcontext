"use client";

/**
 * Kanban — the drag-and-drop column board behind `board`-renderer saved
 * views (`board-renderer.tsx`). Columns are React Aria `GridList`s sharing one
 * `useListData` list; a card's column is a field of the item, so a drop
 * across columns is "update the item's column, then reorder it next to the
 * target".
 *
 * What the board relies on and must not break:
 * - `setColumn(item, column)` runs exactly once per cross-column drop
 *   (`onInsert` / `onRootDrop`) and never on a same-column reorder
 *   (`onReorder` only moves keys). The board records optimistic moves inside
 *   that callback.
 * - `useKanban` returns a fresh object every render (no memo): the board's
 *   resync effect depends on `list` and is expected to run on every commit.
 * - `Kanban.Card` must stay a direct child of `Kanban.CardList` (it is a
 *   `GridListItem`), so `onAction`, keyboard navigation and drag keep working.
 */
import { useCallback, useEffect, useMemo, type HTMLAttributes, type JSX, type ReactNode } from "react";
import { ScrollShadow } from "@heroui/react";
import {
  DropIndicator,
  GridList,
  GridListItem,
  isTextDropItem,
  useDragAndDrop,
  useListData,
  type DropIndicatorProps,
  type GridListItemProps,
  type GridListProps,
  type ListData,
} from "react-aria-components";
import { LazyMotion, domMax } from "motion/react";
import * as m from "motion/react-m";
import { cn } from "@bcontext-dev/contract/utils";

type DndOptions = Parameters<typeof useDragAndDrop>[0];
type RenderDropIndicator = NonNullable<DndOptions["renderDropIndicator"]>;
type DropTarget = Parameters<RenderDropIndicator>[0];

export interface UseKanbanOptions<T extends object> {
  initialItems: T[];
  getColumn: (item: T) => string;
  setColumn: (item: T, column: string) => T;
  dragType?: string;
  getKey?: (item: T) => string | number;
}

export interface UseKanbanReturn<T extends object> {
  list: ListData<T>;
  addItem: (item: T) => void;
  removeItem: (key: string | number) => void;
  moveItem: (key: string | number, toColumn: string) => void;
  updateItem: (key: string | number, item: T) => void;
  getColumn: (item: T) => string;
  setColumn: (item: T, column: string) => T;
  dragType: string;
}

export interface UseKanbanColumnOptions {
  renderDropIndicator?: DndOptions["renderDropIndicator"];
}

/** One list for the whole board; columns are filtered views of it. */
export function useKanban<T extends object>(options: UseKanbanOptions<T>): UseKanbanReturn<T> {
  const { dragType = "kanban-item-id", getColumn, getKey, initialItems, setColumn } = options;
  const list = useListData<T>({ initialItems, getKey });
  return {
    list,
    dragType,
    getColumn,
    setColumn,
    addItem: (item) => list.append(item),
    removeItem: (key) => list.remove(key),
    updateItem: (key, item) => list.update(key, item),
    moveItem: (key, toColumn) => {
      const item = list.getItem(key);
      if (item) list.update(key, setColumn(item, toColumn));
    },
  };
}

/** The items of one column plus the drag-and-drop hooks its `CardList` needs. */
export function useKanbanColumn<T extends object>(
  kanban: UseKanbanReturn<T>,
  column: string,
  options?: UseKanbanColumnOptions,
) {
  const { dragType, getColumn, list, setColumn } = kanban;
  const items = useMemo(() => list.items.filter((item) => getColumn(item) === column), [list.items, getColumn, column]);

  // Cards travel as their key in a private drag type, so a drop from another
  // column (another GridList) can find the item in the shared list.
  const adopt = async (dropItems: Parameters<NonNullable<DndOptions["onRootDrop"]>>[0]["items"]) => {
    const keys = await Promise.all(dropItems.filter(isTextDropItem).map((item) => item.getText(dragType)));
    for (const key of keys) {
      const item = list.getItem(key);
      if (item) list.update(key, setColumn(item, column));
    }
    return keys;
  };

  const { dragAndDropHooks } = useDragAndDrop({
    acceptedDragTypes: [dragType],
    getDropOperation: () => "move",
    getItems: (keys) => [...keys].map((key) => ({ [dragType]: String(key), "text/plain": String(key) })),
    async onInsert(event) {
      const keys = await adopt(event.items);
      if (event.target.dropPosition === "before") list.moveBefore(event.target.key, keys);
      else if (event.target.dropPosition === "after") list.moveAfter(event.target.key, keys);
    },
    onReorder(event) {
      if (event.target.dropPosition === "before") list.moveBefore(event.target.key, event.keys);
      else if (event.target.dropPosition === "after") list.moveAfter(event.target.key, event.keys);
    },
    async onRootDrop(event) {
      await adopt(event.items);
    },
    renderDropIndicator: options?.renderDropIndicator,
  });

  return { items, dragAndDropHooks };
}

/**
 * Sizes the drop placeholder to the card being dragged: React Aria marks the
 * dragged item with `data-dragging`, and its height becomes the
 * `--kanban-drop-height` the indicator reads.
 */
export function useKanbanCardPlaceholder(options: { renderIndicator: (target: DropTarget) => JSX.Element }) {
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      const dragging = document.querySelector("[data-dragging]");
      const height = dragging?.getBoundingClientRect().height ?? 0;
      if (height > 0) root.style.setProperty("--kanban-drop-height", `${height}px`);
      else root.style.removeProperty("--kanban-drop-height");
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ["data-dragging"], subtree: true });
    return () => {
      observer.disconnect();
      root.style.removeProperty("--kanban-drop-height");
    };
  }, []);
  const { renderIndicator } = options;
  const renderDropIndicator = useCallback<RenderDropIndicator>((target) => renderIndicator(target), [renderIndicator]);
  return { renderDropIndicator };
}

function Root({
  className,
  children,
  hideScrollBar,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { hideScrollBar?: boolean; children?: ReactNode; [data: `data-${string}`]: unknown }) {
  return (
    <LazyMotion features={domMax}>
      <ScrollShadow
        orientation="horizontal"
        hideScrollBar={hideScrollBar}
        data-slot="kanban"
        className={cn(
          // `kanban` is the hook BoardTopScrollbar finds the scroller by.
          "kanban grid snap-x snap-mandatory auto-cols-[minmax(280px,1fr)] grid-flow-col gap-4 overflow-x-auto",
          className,
        )}
        {...rest}
      >
        {children}
      </ScrollShadow>
    </LazyMotion>
  );
}

function Column({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return <section data-slot="kanban-column" className={cn("flex min-w-[280px] snap-center flex-col gap-2", className)} {...rest} />;
}

function ColumnHeader({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return <header data-slot="kanban-column-header" className={cn("group/kanban-header flex items-center gap-2 px-1 py-1.5", className)} {...rest} />;
}

function ColumnIndicator({ className, children, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      data-slot="kanban-column-indicator"
      className={cn(
        "shrink-0",
        children == null ? "size-2.5 rounded-full bg-default" : "flex items-center justify-center text-muted [&_svg]:size-4",
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}

function ColumnTitle({ className, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 data-slot="kanban-column-title" className={cn("m-0 text-sm font-semibold text-foreground", className)} {...rest} />;
}

function ColumnCount({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span data-slot="kanban-column-count" className={cn("text-xs font-medium text-muted", className)} {...rest} />;
}

/** Revealed on header hover (pointer devices) or when it holds focus or an open menu. */
function ColumnActions({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="kanban-column-actions"
      className={cn(
        "ms-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 motion-reduce:transition-none",
        "focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100 [@media(hover:hover)]:group-hover/kanban-header:opacity-100",
        className,
      )}
      {...rest}
    />
  );
}

function ColumnBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="kanban-column-body"
      className={cn(
        "flex min-h-[100px] flex-1 flex-col rounded-[calc(var(--radius-2xl)+var(--radius-sm))] bg-[color-mix(in_oklab,var(--default)_40%,transparent)]",
        className,
      )}
      {...rest}
    />
  );
}

function CardList<T extends object>({
  className,
  renderEmptyState,
  selectionMode = "none",
  ...rest
}: GridListProps<T> & { className?: string }) {
  return (
    <GridList<T>
      data-slot="kanban-card-list"
      selectionMode={selectionMode}
      className={cn(
        "flex min-h-full flex-1 flex-col gap-2 p-2 pb-4 outline-none data-[empty]:items-center data-[empty]:justify-center",
        "data-[focus-visible]:ring-2 data-[focus-visible]:ring-[var(--focus)]",
        className,
      )}
      renderEmptyState={
        renderEmptyState
          ? (props) => (
              <div data-slot="kanban-empty" className="flex items-center justify-center py-8 text-center text-sm text-muted">
                {renderEmptyState(props)}
              </div>
            )
          : undefined
      }
      {...rest}
    />
  );
}

const CARD_LAYOUT = { layout: { type: "spring", bounce: 0.15, duration: 0.35 } } as const;

function Card({ className, children, ...rest }: Omit<GridListItemProps, "className" | "children"> & { className?: string; children?: ReactNode }) {
  return (
    <GridListItem
      data-slot="kanban-card"
      className={cn(
        "group/kanban-card relative cursor-pointer select-none rounded-[calc(var(--radius)*1.5)] outline-none transition-opacity duration-200 motion-reduce:transition-none",
        "data-[dragging]:opacity-50 data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        "data-[focus-visible]:ring-2 data-[focus-visible]:ring-[var(--color-separator)]",
        className,
      )}
      {...rest}
    >
      {/* `layout` animates cards sliding into place after a drop or a resync. */}
      <m.div
        layout
        transition={CARD_LAYOUT}
        data-slot="kanban-card-content"
        className={cn(
          "flex flex-col gap-2 overflow-hidden rounded-[calc(var(--radius)*1.5)] bg-overlay p-3 text-sm transition-shadow duration-150 motion-reduce:transition-none",
          "[@media(hover:hover)]:group-hover/kanban-card:shadow-sm group-data-[selected]/kanban-card:bg-accent-soft",
        )}
      >
        {children}
      </m.div>
    </GridListItem>
  );
}

/** Placeholder slot shown where a dragged card would land, sized by `useKanbanCardPlaceholder`. */
function KanbanDropIndicator({ className, ...rest }: Omit<DropIndicatorProps, "className"> & { className?: string }) {
  return (
    <DropIndicator
      data-slot="kanban-drop-indicator"
      className={cn(
        "outline-none data-[drop-target]:h-[var(--kanban-drop-height,2.5rem)] data-[drop-target]:shrink-0 data-[drop-target]:rounded-[calc(var(--radius)*1.5)] data-[drop-target]:border data-[drop-target]:border-separator data-[drop-target]:transition-[height] data-[drop-target]:duration-150 data-[drop-target]:ease-out",
        className,
      )}
      {...rest}
    />
  );
}

export const Kanban = Object.assign(Root, {
  Column,
  ColumnHeader,
  ColumnIndicator,
  ColumnTitle,
  ColumnCount,
  ColumnActions,
  ColumnBody,
  CardList,
  Card,
  DropIndicator: KanbanDropIndicator,
});
