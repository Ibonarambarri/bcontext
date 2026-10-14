"use client";

/**
 * The editor's code-block NodeView. `editor.tsx` installs it through
 * `withCodeBlockView` on TipTap's CodeBlockLowlight extension; the note
 * below says what it renders and why mermaid is loaded lazily.
 */
import { useEffect, useRef, useState } from "react";
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import type { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";

/**
 * Code-block NodeView. For every language it renders the normal editable
 * <pre><code> (lowlight decorations keep working through contentDOM); when
 * the language is `mermaid` it also renders the diagram below the source,
 * live-updated with a short debounce. The markdown on disk stays a plain
 * ```mermaid fence, so agents can write diagrams over MCP.
 *
 * mermaid is heavy, so it is imported dynamically only when a mermaid
 * block actually exists in the open node.
 */

let mermaidReady: Promise<typeof import("mermaid")["default"]> | null = null;
/** One import + initialize per page; the theme is read once, at first use. */
function loadMermaid() {
  mermaidReady ??= import("mermaid").then((m) => {
    const dark =
      document.documentElement.dataset.theme === "dark" ||
      document.documentElement.classList.contains("dark");
    m.default.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: dark ? "dark" : "neutral",
      fontFamily: "inherit",
    });
    return m.default;
  });
  return mermaidReady;
}

// mermaid.render needs a unique element id per call or it reuses stale SVG.
let renderSeq = 0;

function MermaidPreview({ source }: { source: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void (async () => {
        try {
          const mermaid = await loadMermaid();
          const { svg: out } = await mermaid.render(
            `bctx-mermaid-${++renderSeq}`,
            source,
          );
          setSvg(out);
          setError(null);
        } catch (err) {
          setError(err instanceof Error ? err.message.split("\n")[0]! : "diagram error");
        }
      })();
    }, 350);
    return () => clearTimeout(timer.current);
  }, [source]);

  if (error) {
    return (
      <div
        className="mono mt-1 rounded-md border border-[var(--line)] px-3 py-2 text-[10px] uppercase tracking-[0.1em] text-[var(--warn)]"
        contentEditable={false}
      >
        mermaid: {error}
      </div>
    );
  }
  if (!svg) return null;
  return (
    <div
      className="mt-1 overflow-x-auto rounded-md border border-[var(--line)] bg-[var(--paper-2)] p-3 [&_svg]:mx-auto [&_svg]:max-w-full"
      contentEditable={false}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function CodeBlockView({ node }: NodeViewProps) {
  const language = (node.attrs.language as string | null) ?? null;
  const isMermaid = language === "mermaid";
  return (
    <NodeViewWrapper>
      <pre>
        <NodeViewContent<"code"> as="code" />
      </pre>
      {isMermaid ? <MermaidPreview source={node.textContent} /> : null}
    </NodeViewWrapper>
  );
}

/** Extend the lowlight code-block extension with this NodeView; keeps its schema and commands. */
export function withCodeBlockView(ext: typeof CodeBlockLowlight) {
  return ext.extend({
    addNodeView() {
      return ReactNodeViewRenderer(CodeBlockView);
    },
  });
}
