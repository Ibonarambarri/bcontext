"use client";

/**
 * EmptyState — the centred "nothing here yet" block every list, renderer and
 * tab shows when it has no rows: an optional round icon, a title, a line of
 * description and an optional row of actions.
 *
 * Compound API (`EmptyState.Header/Media/Title/Description/Content`) so call
 * sites read as a layout, not a prop bag. `size` lives on the root and flows
 * to the parts through context, because the icon disc and the title scale
 * with it. Every part merges its `className` last (tailwind-merge), so a call
 * site can left-align (`items-start text-left`) or re-pad the block without
 * fighting the defaults.
 *
 * Must not break: this is a client module, and a Server Component that
 * reaches a part through the namespace (`EmptyState.Header`) gets `undefined`
 * (a client reference has no properties on the server) and crashes the page.
 * Server Components import the named parts (`EmptyStateHeader`, …) instead.
 */
import { createContext, useContext, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@bcontext-dev/contract/utils";

type EmptyStateSize = "sm" | "md" | "lg";

const SizeContext = createContext<EmptyStateSize>("md");

const ROOT: Record<EmptyStateSize, string> = {
  sm: "gap-3 px-4 py-6",
  md: "gap-4 px-6 py-8",
  lg: "gap-5 px-8 py-12",
};
const DISC: Record<EmptyStateSize, string> = {
  sm: "size-10 [&_svg]:size-4",
  md: "size-12 [&_svg]:size-5",
  lg: "size-14 [&_svg]:size-6",
};
const TITLE: Record<EmptyStateSize, string> = {
  sm: "text-sm",
  md: "text-base",
  lg: "text-lg",
};

function Root({
  size = "md",
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { size?: EmptyStateSize; children?: ReactNode }) {
  return (
    <SizeContext.Provider value={size}>
      <div
        data-slot="empty-state"
        className={cn("flex flex-col items-center text-center", ROOT[size], className)}
        {...rest}
      >
        {children}
      </div>
    </SizeContext.Provider>
  );
}

function Header({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="empty-state-header" className={cn("flex flex-col items-center gap-2", className)} {...rest} />;
}

/** `variant="icon"` draws the round tinted disc; the default leaves the media bare (illustrations). */
function Media({
  variant = "default",
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { variant?: "default" | "icon" }) {
  const size = useContext(SizeContext);
  return (
    <div
      data-slot="empty-state-media"
      data-variant={variant}
      className={cn(
        "flex shrink-0 items-center justify-center text-muted",
        variant === "icon" && cn("rounded-full bg-default text-foreground", DISC[size]),
        className,
      )}
      {...rest}
    />
  );
}

function Title({ className, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  const size = useContext(SizeContext);
  return <h3 data-slot="empty-state-title" className={cn("font-semibold text-foreground", TITLE[size], className)} {...rest} />;
}

function Description({ className, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  const size = useContext(SizeContext);
  return (
    <p
      data-slot="empty-state-description"
      className={cn(size === "sm" ? "text-xs" : "text-sm", "text-muted", className)}
      {...rest}
    />
  );
}

function Content({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="empty-state-content" className={cn("flex flex-col items-center gap-2", className)} {...rest} />;
}

export const EmptyState = Object.assign(Root, { Header, Media, Title, Description, Content });

export {
  Header as EmptyStateHeader,
  Media as EmptyStateMedia,
  Title as EmptyStateTitle,
  Description as EmptyStateDescription,
  Content as EmptyStateContent,
};
