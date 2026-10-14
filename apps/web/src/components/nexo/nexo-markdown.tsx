"use client";

/**
 * An assistant message body.
 *
 * Streamdown underneath (through `StreamMarkdown` in `ui/chat/markdown`): it repairs
 * Markdown that is still arriving — an unclosed `**`, a fence without its end,
 * a half-typed link — so the message reads right at every token, not only at
 * the last one. Once the stream is done it renders statically.
 *
 * Every block element is mapped to its plain HTML tag so `.chat-md` in
 * `globals.css` is the only thing deciding how it looks; Streamdown's own
 * Tailwind-classed defaults would need its stylesheet and tokens we do not
 * ship. Code goes to `ChatCodeBlock` (Shiki, copy button).
 *
 * Two kinds of link are Nexo's own: `[n]` citation markers, rewritten into
 * `#cite-n` anchors before parsing (see `lib/nexo/markdown.ts`) and rendered
 * as chips; and `/n/<id>` node links, which open the node in the panel
 * instead of navigating away from the conversation.
 */
import { useMemo, type MouseEvent } from "react";
import { StreamMarkdown } from "@/components/ui/chat/markdown";
import { Tooltip } from "@heroui/react";
import type { Components } from "streamdown";
import type { ChatCitation } from "@bcontext-dev/contract/types";
import { parseNodeLink } from "@/lib/node-link";
import { linkCitationMarkers, parseCiteHref } from "@/lib/nexo/markdown";

type OpenNode = (nodeId: string, blockId: string | null) => void;

/** The renderer hands every component the hast `node`; the DOM must not get it. */
function dom<T extends { node?: unknown }>(props: T): Omit<T, "node"> {
  const rest: Record<string, unknown> = { ...props };
  delete rest.node;
  return rest as Omit<T, "node">;
}

/** Block elements rendered as their bare tag, styled by `.chat-md`. */
const PLAIN: Components = {
  p: "p",
  ul: "ul",
  ol: "ol",
  li: "li",
  h1: "h1",
  h2: "h2",
  h3: "h3",
  h4: "h4",
  h5: "h5",
  h6: "h6",
  blockquote: "blockquote",
  hr: "hr",
  strong: "strong",
  em: "em",
  del: "del",
  thead: "thead",
  tbody: "tbody",
  tr: "tr",
  th: "th",
  td: "td",
  sup: "sup",
  sub: "sub",
  // A GFM table needs a scroll container in a 380px panel; the tag alone
  // would push the whole conversation sideways.
  table: (props) => (
    <div className="chat-md__table">
      <table {...dom(props)} />
    </div>
  ),
  // Task-list boxes are read-only in a chat: the node is where you tick them.
  input: (props) => <input {...dom(props)} disabled readOnly />,
};

export function NexoMarkdown({
  content,
  isStreaming,
  citations = [],
  onOpenNode,
}: {
  content: string;
  isStreaming: boolean;
  citations?: ChatCitation[];
  onOpenNode?: OpenNode;
}) {
  const text = useMemo(
    () => linkCitationMarkers(content, citations.length),
    [content, citations.length],
  );

  const components = useMemo<Components>(
    () => ({
      ...PLAIN,
      a: (props) => {
        const { href, children, ...rest } = dom(props);
        const cite = parseCiteHref(href);
        if (cite !== null) {
          const citation = citations[cite - 1];
          if (!citation) return <span>[{cite}]</span>;
          return (
            <InlineCitation
              n={cite}
              citation={citation}
              onOpen={() => onOpenNode?.(citation.node_id, citation.block_id)}
            />
          );
        }
        const link = parseNodeLink(href);
        if (link && onOpenNode) {
          return (
            <a
              {...rest}
              href={href}
              className="chat-md__nodelink"
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
        return (
          <a {...rest} href={href} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        );
      },
    }),
    [citations, onOpenNode],
  );

  return (
    <div className="chat-md" data-streaming={isStreaming ? "true" : undefined}>
      <StreamMarkdown isStreaming={isStreaming} components={components}>
        {text}
      </StreamMarkdown>
    </div>
  );
}

/**
 * A `[n]` marker as a chip: the number stays, so the prose still reads, and
 * the hover says which node it is before you commit to opening it.
 */
function InlineCitation({
  n,
  citation,
  onOpen,
}: {
  n: number;
  citation: ChatCitation;
  onOpen: () => void;
}) {
  return (
    <Tooltip delay={200}>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${citation.title}`}
        className="chat-md__cite"
      >
        {n}
      </button>
      <Tooltip.Content className="max-w-72">
        <span className="font-medium">{citation.title}</span>
        {citation.snippet ? (
          <span className="mt-1 block text-muted">{citation.snippet.slice(0, 160)}</span>
        ) : null}
      </Tooltip.Content>
    </Tooltip>
  );
}
