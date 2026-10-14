/**
 * Navbar — a sticky top bar for public pages: brand on the left, a spacer,
 * a row of text links on the right.
 *
 * Called by the `/docs` header (`app/docs/docs-header.tsx`). It holds no
 * state (no mobile menu, no hide-on-scroll), so it renders on the server.
 * What must not break: the bar stays above page content (`z-40`, sticky)
 * and `maxWidth` centres the row the way the docs layout below it does.
 */
import type { AnchorHTMLAttributes, HTMLAttributes } from "react";
import { cn } from "@bcontext-dev/contract/utils";

const MAX_WIDTH = {
  sm: "max-w-[640px]",
  md: "max-w-[768px]",
  lg: "max-w-[1024px]",
  xl: "max-w-[1280px]",
  "2xl": "max-w-[1536px]",
  full: "max-w-full",
} as const;

function Root({
  position = "sticky",
  maxWidth = "lg",
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLElement> & {
  position?: "sticky" | "static";
  maxWidth?: keyof typeof MAX_WIDTH;
}) {
  return (
    <nav
      data-slot="navbar"
      className={cn(
        "z-40 flex w-full flex-col bg-background",
        position === "sticky" ? "sticky top-0" : "static",
        className,
      )}
      {...rest}
    >
      <header className={cn("mx-auto flex h-12 w-full items-center gap-3 px-4", MAX_WIDTH[maxWidth])}>
        {children}
      </header>
    </nav>
  );
}

/** The brand mark, a plain link (usually out to the marketing site). */
function Brand({ className, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a data-slot="navbar-brand" className={cn("flex shrink-0 items-center gap-2", className)} {...rest} />;
}

function Spacer({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cn("flex-1", className)} {...rest} />;
}

function Content({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="navbar-content" className={cn("flex items-center gap-1", className)} {...rest} />;
}

/** Visual style of a navbar link; the element (a Next `Link`, an `<a>`) is the call site's. */
export const navbarItemClass =
  "flex items-center gap-2 rounded-md px-2 py-1 text-xs text-muted outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus";

export const Navbar = Object.assign(Root, { Brand, Spacer, Content });
