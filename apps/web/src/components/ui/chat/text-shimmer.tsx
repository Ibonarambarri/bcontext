/**
 * TextShimmer — a line of text with a light band sweeping across it, the
 * "still working" signal in Nexo's trace (live tool step, thinking label).
 * The gradient and keyframes live in `chat.css` (`.text-shimmer`); reduced
 * motion turns it into plain dimmed text.
 */
import type { HTMLAttributes } from "react";
import { cn } from "@bcontext-dev/contract/utils";

export function TextShimmer({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span data-slot="text-shimmer" className={cn("text-shimmer", className)} {...rest} />;
}
