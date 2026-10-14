"use client";

/**
 * Markdown for the chat surface, in two flavours sharing one look:
 *
 * - `StreamMarkdown` — Streamdown underneath, for text that is still
 *   arriving: it repairs half-typed Markdown so a message reads right at every
 *   token, animates new words in while `isStreaming`, and renders statically
 *   once the stream ends. `NexoMarkdown` is the caller.
 * - `Markdown` — react-markdown, for finished text (Nexo's reasoning trace).
 *
 * Both render inside a `.markdown` root and send fenced code to
 * `ChatCodeBlock`; everything else is styled by `.chat-md .markdown` in
 * globals.css, so callers keep that wrapper. Caller-supplied `components`
 * override the defaults here.
 */
import { useMemo, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown, { type Components as ReactMarkdownComponents } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { Streamdown, type Components } from "streamdown";
import { cn } from "@bcontext-dev/contract/utils";
import { ChatCodeBlock } from "./chat-code-block";

const REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const ANIMATION = { animation: "blurIn" as const };

function languageOf(className: string | undefined): string {
  return className?.match(/language-(\w+)/)?.[1] ?? "plaintext";
}

function fence(children: ReactNode, className: string | undefined) {
  const code = String(children ?? "").replace(/\n$/, "");
  return <ChatCodeBlock code={code} language={languageOf(className)} />;
}

/** Streamdown separates inline code from fences itself (`inlineCode`). */
const STREAM_DEFAULTS: Components = {
  code: ({ children, className }) => fence(children, className),
  inlineCode: ({ children, className }) => (
    <code className={className} data-slot="markdown-inline-code">
      {children}
    </code>
  ),
  // The fence renders its own <pre>; the outer one would double the box.
  pre: ({ children }) => <>{children}</>,
};

/** react-markdown does not: a code node spanning one line is inline. */
const STATIC_DEFAULTS: ReactMarkdownComponents = {
  code: ({ children, className, node }) => {
    const start = node?.position?.start.line;
    if (!start || start === node?.position?.end.line) {
      return (
        <code className={className} data-slot="markdown-inline-code">
          {children}
        </code>
      );
    }
    return fence(children, className);
  },
  pre: ({ children }) => <>{children}</>,
};

export function StreamMarkdown({
  children,
  className,
  components,
  isStreaming = false,
  ...rest
}: Omit<ComponentProps<"div">, "children"> & {
  children: string;
  components?: Components;
  isStreaming?: boolean;
}) {
  const merged = useMemo(() => (components ? { ...STREAM_DEFAULTS, ...components } : STREAM_DEFAULTS), [components]);
  return (
    <div data-slot="markdown" className={cn("markdown", className)} {...rest}>
      <Streamdown
        normalizeHtmlIndentation
        parseIncompleteMarkdown
        animated={ANIMATION}
        caret={isStreaming ? "block" : undefined}
        components={merged}
        controls={false}
        isAnimating={isStreaming}
        mode={isStreaming ? "streaming" : "static"}
        remarkPlugins={REMARK_PLUGINS}
      >
        {children}
      </Streamdown>
    </div>
  );
}

export function Markdown({
  children,
  className,
  components,
  ...rest
}: Omit<ComponentProps<"div">, "children"> & {
  children: string;
  components?: ReactMarkdownComponents;
}) {
  const merged = useMemo(() => (components ? { ...STATIC_DEFAULTS, ...components } : STATIC_DEFAULTS), [components]);
  return (
    <div data-slot="markdown" className={cn("markdown", className)} {...rest}>
      <ReactMarkdown components={merged} remarkPlugins={REMARK_PLUGINS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
