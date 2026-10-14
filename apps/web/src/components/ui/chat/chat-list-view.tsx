"use client";

/**
 * ChatListView — a list of past conversations (`nexo-history.tsx`): a
 * react-aria GridList, so arrow keys move between rows and Enter/click fires
 * `onAction`, with rows separated by hairlines and tinted on hover.
 *
 * `density="compact"` is the narrow rail: it hides the preview line and the
 * trailing meta slot so a row is just icon + title. Keep that rule in mind
 * before putting an essential control in `.Meta`.
 */
import { createContext, useContext, type HTMLAttributes } from "react";
import {
  GridList,
  GridListItem,
  type GridListItemProps,
  type GridListProps,
} from "react-aria-components";
import { cn } from "@bcontext-dev/contract/utils";

type Density = "comfortable" | "compact";

const DensityContext = createContext<Density>("comfortable");

function Root<T extends object>({
  density = "comfortable",
  className,
  ...rest
}: Omit<GridListProps<T>, "className"> & { density?: Density; className?: string }) {
  return (
    <DensityContext.Provider value={density}>
      <GridList<T>
        data-slot="chat-list-view"
        data-density={density}
        className={cn("relative min-h-0 w-full outline-none", className)}
        {...rest}
      />
    </DensityContext.Provider>
  );
}

function Item({ className, ...rest }: Omit<GridListItemProps, "className"> & { className?: string }) {
  return (
    <GridListItem
      data-slot="chat-list-view-item"
      className={cn(
        "flex cursor-pointer items-center gap-3 border-b border-separator-tertiary/50 bg-transparent px-4 py-3 text-sm outline-none last:border-b-0",
        "[@media(hover:hover)]:hover:bg-default/50 data-[selected]:bg-accent-soft data-[focus-visible]:shadow-[inset_0_0_0_2px_var(--color-focus)]",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...rest}
    />
  );
}

function ItemContent({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="chat-list-view-item-content"
      className={cn("flex min-w-0 flex-1 items-center gap-3 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted", className)}
      {...rest}
    />
  );
}

function Icon({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="chat-list-view-icon"
      className={cn("flex size-4 shrink-0 items-center justify-center text-muted", className)}
      {...rest}
    />
  );
}

function Text({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="chat-list-view-text" className={cn("flex min-w-0 flex-col", className)} {...rest} />;
}

function Title({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      data-slot="chat-list-view-title"
      className={cn("truncate text-sm font-medium text-foreground", className)}
      {...rest}
    />
  );
}

function Preview({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  const density = useContext(DensityContext);
  if (density === "compact") return null;
  return <span data-slot="chat-list-view-preview" className={cn("truncate text-xs text-muted", className)} {...rest} />;
}

function Meta({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const density = useContext(DensityContext);
  if (density === "compact") return null;
  return (
    <div
      data-slot="chat-list-view-meta"
      className={cn("ms-auto shrink-0 ps-2 text-[11px] text-muted", className)}
      {...rest}
    />
  );
}

export const ChatListView = Object.assign(Root, { Item, ItemContent, Icon, Text, Title, Preview, Meta });
