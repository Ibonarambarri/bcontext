/**
 * ChatLoader — the two waits in a chat (`nexo-conversation.tsx`): `.Dots`,
 * three bouncing dots while an answer has not started, and `.Skeleton`, an
 * avatar disc plus three shrinking lines while past messages load. The dot
 * animation lives in chat.css (`.chat-loader__dot`), which also stills it
 * under reduced motion.
 */
import type { HTMLAttributes } from "react";
import { cn } from "@bcontext-dev/contract/utils";

function Dots({ className, label, ...rest }: HTMLAttributes<HTMLSpanElement> & { label?: string }) {
  return (
    <span
      data-slot="chat-loader-dots"
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("inline-flex items-center gap-1", className)}
      {...rest}
    >
      <span className="chat-loader__dot" />
      <span className="chat-loader__dot" />
      <span className="chat-loader__dot" />
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}

function Skeleton({ className, label, ...rest }: HTMLAttributes<HTMLDivElement> & { label?: string }) {
  return (
    <div
      data-slot="chat-loader-skeleton"
      aria-busy="true"
      aria-label={label}
      role={label ? "status" : undefined}
      className={cn("flex w-full items-start gap-3", className)}
      {...rest}
    >
      <div className="size-8 shrink-0 rounded-full bg-default" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="h-3 w-full rounded-lg bg-default" />
        <div className="h-3 w-[85%] rounded-lg bg-default" />
        <div className="h-3 w-[65%] rounded-lg bg-default" />
      </div>
    </div>
  );
}

export const ChatLoader = { Dots, Skeleton };
