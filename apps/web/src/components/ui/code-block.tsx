"use client";

/**
 * CodeBlock — a read-only, syntax-highlighted snippet with a header and a
 * copy button. Used by the Add agent modal for MCP configs, install
 * one-liners and the generated agent instructions.
 *
 * Highlighting is shiki's `codeToHtml` with a light and a dark theme emitted
 * as CSS variables (`defaultColor: false`); `ui.css` picks `--shiki-light` or
 * `--shiki-dark` from the theme on <html>. shiki is imported on first render
 * of a block, not at module load, so the modal's chunk does not carry it, and
 * the plain `<pre>` is shown until the HTML for the current code arrives — a
 * stale highlight for a previous `code` is never shown.
 */
import { useEffect, useRef, useState, type HTMLAttributes } from "react";
import { Button } from "@heroui/react";
import { Check, Copy } from "lucide-react";
import { cn } from "@bcontext-dev/contract/utils";

function Root({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="code-block"
      className={cn(
        "code-block my-2 flex w-full flex-col overflow-clip rounded-[calc(var(--radius)*2)] bg-surface-secondary text-surface-secondary-foreground",
        className,
      )}
      {...rest}
    />
  );
}

function Header({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="code-block-header"
      className={cn("flex items-center justify-between gap-2 px-3 pt-2", className)}
      {...rest}
    />
  );
}

interface CodeProps extends HTMLAttributes<HTMLDivElement> {
  code: string;
  language?: string;
}

function Code({ code, language = "plaintext", className, ...rest }: CodeProps) {
  const key = `${language}:${code}`;
  const [highlighted, setHighlighted] = useState<{ key: string; html: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { codeToHtml } = await import("shiki");
        const html = await codeToHtml(code, {
          lang: language,
          themes: { light: "github-light", dark: "github-dark" },
          defaultColor: false,
        });
        if (!cancelled) setHighlighted({ key, html });
      } catch {
        // Unknown language or a failed chunk load: the plain <pre> stays.
        if (!cancelled) setHighlighted(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, key, language]);

  const classes = cn("code-block__code", className);
  if (highlighted?.key === key) {
    return <div data-slot="code-block-code" className={classes} dangerouslySetInnerHTML={{ __html: highlighted.html }} {...rest} />;
  }
  return (
    <div data-slot="code-block-code" className={classes} {...rest}>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function CopyButton({ code, className, "aria-label": ariaLabel = "Copy code" }: { code: string; className?: string; "aria-label"?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  const Icon = copied ? Check : Copy;
  return (
    <Button
      isIconOnly
      size="sm"
      variant="ghost"
      aria-label={ariaLabel}
      data-slot="code-block-copy-button"
      className={cn("size-6 min-w-6 text-muted hover:text-foreground [&_svg]:m-0 [&_svg]:size-3", className)}
      onPress={async () => {
        try {
          await navigator.clipboard.writeText(code);
          setCopied(true);
          if (timer.current !== null) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => {
            setCopied(false);
            timer.current = null;
          }, 2000);
        } catch {
          // Clipboard refused (insecure context, denied permission): nothing to undo.
        }
      }}
    >
      <Icon key={copied ? "check" : "copy"} className="animate-in fade-in zoom-in-50 duration-200" />
    </Button>
  );
}

export const CodeBlock = Object.assign(Root, { Header, Code, CopyButton });
