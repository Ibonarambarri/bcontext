/**
 * ItemCard / ItemCardGroup — a row (or tile) with an optional leading icon,
 * a title and description that truncate, and a trailing action. The
 * workspace cards on /workspaces and the dashboard's node rows are ItemCards;
 * the dashboard sections stack them inside an ItemCardGroup, which flattens
 * each card into a divided row of one shared surface.
 *
 * `render` swaps the root element so a card can be the link itself (Next
 * `Link` or a plain `<a>`): it receives the merged props — className,
 * data-slot, children — and must spread them onto a single element. The
 * group targets its cards through `data-slot="item-card"`, so that attribute
 * must survive any `render`.
 */
import type { ComponentPropsWithoutRef, HTMLAttributes, JSX, ReactElement } from "react";
import { cn } from "@bcontext-dev/contract/utils";

type Variant = "default" | "secondary" | "tertiary" | "outline" | "transparent";

const VARIANT: Record<Variant, string> = {
  default: "bg-surface shadow-surface",
  secondary: "bg-surface-secondary",
  tertiary: "bg-surface-tertiary",
  outline: "border border-border bg-transparent",
  transparent: "bg-transparent shadow-none",
};

type Tag = keyof JSX.IntrinsicElements;

type RootProps<E extends Tag> = ComponentPropsWithoutRef<E> & {
  variant?: Variant;
  /** The element to render instead of the default `<div>`; `ItemCard<"a">` types its props. */
  render?: (props: ComponentPropsWithoutRef<E> & { "data-slot": string }) => ReactElement;
};

function Root<E extends Tag = "div">({ variant = "default", render, className, ...rest }: RootProps<E>) {
  const props = {
    ...rest,
    "data-slot": "item-card",
    className: cn("flex items-center gap-3 rounded-[calc(var(--radius)*2)] px-4 py-3", VARIANT[variant], className),
  } as ComponentPropsWithoutRef<E> & { "data-slot": string };
  if (render) return render(props);
  return <div {...(props as HTMLAttributes<HTMLDivElement>)} />;
}

function Icon({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="item-card-icon"
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-[var(--radius)] bg-default text-foreground [&_svg]:size-4",
        className,
      )}
      {...rest}
    />
  );
}

function Content({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="item-card-content" className={cn("flex min-w-0 flex-1 flex-col", className)} {...rest} />;
}

function Title({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      data-slot="item-card-title"
      className={cn("w-fit overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium text-foreground", className)}
      {...rest}
    />
  );
}

function Description({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      data-slot="item-card-description"
      className={cn("mt-0.5 w-fit overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted", className)}
      {...rest}
    />
  );
}

function Action({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="item-card-action" className={cn("ms-auto shrink-0 ps-2", className)} {...rest} />;
}

export const ItemCard = Object.assign(Root, { Icon, Content, Title, Description, Action });

/** A list of ItemCards on one surface; place `Separator`s between them for divided rows. */
export function ItemCardGroup({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="group"
      data-slot="item-card-group"
      className={cn(
        "flex flex-col rounded-[calc(var(--radius)*2)] bg-surface shadow-surface",
        "[&>[data-slot=item-card]]:rounded-none [&>[data-slot=item-card]]:border-0 [&>[data-slot=item-card]]:bg-transparent [&>[data-slot=item-card]]:shadow-none",
        className,
      )}
      {...rest}
    />
  );
}
