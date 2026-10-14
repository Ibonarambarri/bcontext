"use client";

/**
 * ListView — a React Aria `GridList` dressed as a divided list of rows,
 * used by `saved-list-view.tsx` for every list-shaped saved view.
 *
 * Rows are `GridListItem`s, so keyboard navigation, `onAction` and selection
 * come from React Aria; anything placed inside a row must stay a plain child
 * (no trigger wrappers) or those break. The `list-view__item` class is kept
 * on every row because call sites target it (e.g. to drop the last divider).
 * Default styles for nested icons use `:where()` so a call site's own
 * `text-*` / `size-*` on an icon always wins.
 */
import { createContext, useContext, type HTMLAttributes, type ReactNode } from "react";
import { GridList, GridListItem, type GridListItemProps, type GridListProps } from "react-aria-components";
import { cn } from "@bcontext-dev/contract/utils";

type ListViewVariant = "primary" | "secondary";

const VariantContext = createContext<ListViewVariant>("primary");

function Root<T extends object>({
  className,
  variant = "primary",
  selectionMode = "none",
  renderEmptyState,
  ...rest
}: Omit<GridListProps<T>, "className"> & { className?: string; variant?: ListViewVariant }) {
  return (
    <VariantContext.Provider value={variant}>
      <GridList<T>
        data-slot="list-view"
        selectionMode={selectionMode === "none" ? undefined : selectionMode}
        className={cn(
          "list-view relative w-full min-h-0 outline-none",
          variant === "primary" && "rounded-[calc(var(--radius)*2.5)] bg-surface-secondary p-1",
          className,
        )}
        renderEmptyState={
          renderEmptyState
            ? (props) => (
                <div data-slot="list-view-empty-state" className="flex items-center justify-center px-4 py-8">
                  {renderEmptyState(props)}
                </div>
              )
            : undefined
        }
        {...rest}
      />
    </VariantContext.Provider>
  );
}

function Item({ className, children, ...rest }: Omit<GridListItemProps, "className" | "children"> & { className?: string; children?: ReactNode }) {
  const variant = useContext(VariantContext);
  return (
    <GridListItem
      data-slot="list-view-item"
      className={cn(
        "list-view__item flex cursor-pointer items-center gap-3 px-4 py-3 text-sm outline-none",
        "border-b border-[color-mix(in_oklab,var(--separator-tertiary)_50%,transparent)] last:border-b-0",
        "data-[focus-visible]:shadow-[inset_0_0_0_2px_var(--color-focus)] data-[dragging]:opacity-50 data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        variant === "primary"
          ? "bg-surface first:rounded-t-[calc(var(--radius)*2)] last:rounded-b-[calc(var(--radius)*2)] [@media(hover:hover)]:data-[hovered]:bg-[color-mix(in_oklab,var(--surface)_40%,transparent)]"
          : "bg-transparent [@media(hover:hover)]:data-[hovered]:bg-[color-mix(in_oklab,var(--default)_50%,transparent)] data-[selected]:bg-accent-soft",
        className,
      )}
      {...rest}
    >
      {children}
    </GridListItem>
  );
}

function ItemContent({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="list-view-item-content"
      className={cn(
        "flex min-w-0 flex-1 items-center gap-3 [:where(&)_svg]:size-4 [:where(&)_svg]:shrink-0 [:where(&)_svg]:text-muted",
        className,
      )}
      {...rest}
    />
  );
}

function Title({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      data-slot="list-view-title"
      className={cn("truncate text-sm font-medium text-foreground", className)}
      {...rest}
    />
  );
}

function Description({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span data-slot="list-view-description" className={cn("mt-0.5 truncate text-xs text-muted", className)} {...rest} />;
}

function ItemAction({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="list-view-item-action" className={cn("ms-auto shrink-0 ps-2", className)} {...rest} />;
}

export const ListView = Object.assign(Root, { Item, ItemContent, Title, Description, ItemAction });
