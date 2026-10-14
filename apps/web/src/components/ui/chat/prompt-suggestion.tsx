"use client";

/**
 * PromptSuggestion — the empty state of a chat that doubles as an offer
 * (`nexo-conversation.tsx` → `NexoSuggestions`): a title, a line of
 * description, and a grid of bordered prompt pills that send themselves when
 * pressed. Items are react-aria Buttons so keyboard and press handling match
 * the rest of HeroUI. The grid goes two-up from `sm`; callers override it with
 * container-query classes when their column is narrower than the viewport.
 */
import type { HTMLAttributes, ReactNode } from "react";
import { Button as AriaButton, type ButtonProps } from "react-aria-components";
import { ChevronRight } from "lucide-react";
import { cn } from "@bcontext-dev/contract/utils";

function Root({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="prompt-suggestion" className={cn("flex w-full flex-col gap-8", className)} {...rest} />;
}

function Header({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="prompt-suggestion-header" className={cn("flex flex-col gap-2", className)} {...rest} />;
}

function Title({ className, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      data-slot="prompt-suggestion-title"
      className={cn("text-2xl font-semibold tracking-tight text-foreground", className)}
      {...rest}
    />
  );
}

function Description({ className, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return <p data-slot="prompt-suggestion-description" className={cn("max-w-[640px] text-sm text-muted", className)} {...rest} />;
}

function Items({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="prompt-suggestion-items"
      className={cn("grid w-full auto-rows-auto grid-cols-1 gap-2 sm:grid-cols-2", className)}
      {...rest}
    />
  );
}

function Item({ className, children, ...rest }: Omit<ButtonProps, "children" | "className"> & { className?: string; children?: ReactNode }) {
  return (
    <AriaButton
      data-slot="prompt-suggestion-item"
      className={cn(
        "group/suggestion flex h-auto w-full cursor-pointer items-start justify-between gap-3 whitespace-normal rounded-xl border border-border bg-transparent px-4 py-3 text-start text-sm leading-snug text-foreground outline-none transition-colors",
        "[@media(hover:hover)]:hover:bg-default/40 data-[focus-visible]:shadow-[inset_0_0_0_2px_var(--color-focus)]",
        className,
      )}
      {...rest}
    >
      <span className="flex min-w-0 items-center text-pretty">{children}</span>
      <ChevronRight
        aria-hidden
        className="mt-0.5 size-4 shrink-0 text-muted opacity-0 transition-opacity group-hover/suggestion:opacity-100 group-data-[hovered]/suggestion:opacity-100"
      />
    </AriaButton>
  );
}

export const PromptSuggestion = Object.assign(Root, { Header, Title, Description, Items, Item });
