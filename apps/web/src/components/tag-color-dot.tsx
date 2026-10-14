import { cn } from "@bcontext-dev/contract/utils";
import { tagColorCss } from "@/lib/tag-color";

/**
 * A tag's identity color, wherever the tag is named.
 *
 * The graph paints tag hubs in a hue derived from the tag id; this is the
 * same hue at chip scale. It exists so the color is a property of the TAG
 * rather than a decoration the canvas invented: without it the graph is once
 * again the only surface in the app with color in it, which is the whole
 * reason it read as bolted on.
 */
export function TagColorDot({ tagId, className }: { tagId: string; className?: string }) {
  return (
    <i
      aria-hidden="true"
      className={cn("inline-block size-1.5 shrink-0 rounded-full", className)}
      style={{ backgroundColor: tagColorCss(tagId) }}
    />
  );
}
