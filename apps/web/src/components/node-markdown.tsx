"use client";

/**
 * Read-only Markdown for the node panel: the node's content rendered as
 * prose (GFM tables, task lists, line breaks), split by H2 so every block
 * keeps its `data-inspector-block` anchor for deep links and highlight.
 * Links to other nodes (`/n/<id>`, with or without the workspace prefix,
 * `#block` allowed) open in the panel through `onOpenNode` instead of
 * navigating; everything else opens in a new tab.
 */

import { useMemo, type MouseEvent } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { extractBlocks } from "@bcontext-dev/contract/rag/chunk";
import { cn } from "@bcontext-dev/contract/utils";
import { parseNodeLink } from "@/lib/node-link";

export function NodeMarkdown({
  markdown,
  activeBlockId,
  onOpenNode,
  className,
}: {
  markdown: string;
  activeBlockId?: string | null;
  onOpenNode?: (id: string, blockId: string | null) => void;
  className?: string;
}) {
  const slices = useMemo(() => {
    const blocks = extractBlocks(markdown);
    const preamble = blocks.length > 0 ? markdown.slice(0, blocks[0]!.start).trim() : markdown.trim();
    return { preamble, blocks };
  }, [markdown]);

  const components = useMemo<Components>(() => ({
    a: ({ href, children, ...rest }) => {
      const link = parseNodeLink(href);
      if (link && onOpenNode) {
        return (
          <a
            {...rest}
            href={href}
            className="node-md__nodelink"
            onClick={(event: MouseEvent<HTMLAnchorElement>) => {
              if (event.metaKey || event.ctrlKey) return;
              event.preventDefault();
              onOpenNode(link.id, link.blockId);
            }}
          >
            {children}
          </a>
        );
      }
      return <a {...rest} href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
    },
    // Task-list checkboxes are read-only here; the editor owns them.
    input: ({ ...rest }) => <input {...rest} disabled readOnly />,
  }), [onOpenNode]);

  if (!markdown.trim()) {
    return <p className="text-[12.5px] text-[var(--ink-3)]">No content yet.</p>;
  }

  return (
    <div className={cn("node-md", className)}>
      {slices.preamble ? (
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>{slices.preamble}</ReactMarkdown>
      ) : null}
      {slices.blocks.map((block) => (
        <section
          key={block.block_id}
          data-inspector-block={block.block_id}
          className={cn("node-md__block scroll-mt-3 rounded-md transition-shadow", activeBlockId === block.block_id && "node-md__block--active")}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>{block.body_md}</ReactMarkdown>
        </section>
      ))}
    </div>
  );
}
