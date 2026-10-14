"use client";

/**
 * Markdown a Nexo wrote (an inbox item, a run's output, its own instructions)
 * rendered the way its chat renders it: the same `NexoMarkdown` — Streamdown,
 * which sanitizes HTML and hardens links — with `/n/<id>` links opening the
 * node in the side panel instead of leaving the page.
 *
 * The renderer is the heavy part of the chat (Streamdown, Shiki), so it is
 * its own chunk, loaded on first use; the text it renders always arrives
 * after a fetch, so the chunk loads alongside it. Used by the Inbox,
 * Activity and Setup → Instructions.
 */
import dynamic from "next/dynamic";
import { useCallback } from "react";
import { cn } from "@bcontext-dev/contract/utils";
import { useWorkspace } from "@/components/workspace-context";

const NexoMarkdown = dynamic(() => import("@/components/nexo/nexo-markdown").then((m) => m.NexoMarkdown), {
  ssr: false,
  loading: () => <span className="block h-4" aria-hidden="true" />,
});

export function NexoRichText({ markdown, className }: { markdown: string; className?: string }) {
  const { selectNode } = useWorkspace();
  const openNode = useCallback((nodeId: string, blockId: string | null) => selectNode(nodeId, { blockId }), [selectNode]);
  if (!markdown.trim()) return null;
  return (
    <div className={cn("nexo-rich-text min-w-0 text-[12.5px] leading-[1.6] text-[var(--ink-2)]", className)}>
      <NexoMarkdown content={markdown} isStreaming={false} onOpenNode={openNode} />
    </div>
  );
}
