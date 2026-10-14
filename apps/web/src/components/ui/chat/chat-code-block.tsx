"use client";

/**
 * A fenced code block for the chat surface: Shiki-highlighted (light and dark
 * themes at once), with an optional header carrying the language and a copy
 * button. Used by the chat Markdown renderers for ``` fences and by ChatTool
 * for a call's JSON input and result.
 *
 * Shiki is imported lazily inside the effect: it is large, the Nexo chunk is
 * already behind a dynamic import, and the plain `<pre>` fallback renders the
 * same text until the highlighted HTML is ready. Keep `data-slot="code-block"`
 * on the root — `.chat-md .markdown [data-slot="code-block"]` in globals.css
 * sizes it inside a message.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@heroui/react";
import { Check, Copy } from "lucide-react";
import { cn } from "@bcontext-dev/contract/utils";

export function ChatCodeBlock({
  code,
  language = "plaintext",
  showHeader = true,
  className,
}: {
  code: string;
  language?: string;
  showHeader?: boolean;
  className?: string;
}) {
  const key = `${language}:${code}`;
  const [highlighted, setHighlighted] = useState<{ key: string; html: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!code) return;
      try {
        const { codeToHtml } = await import("shiki");
        const html = await codeToHtml(code, {
          lang: language,
          themes: { light: "github-light", dark: "github-dark" },
          defaultColor: false,
        });
        if (!cancelled) setHighlighted({ key, html });
      } catch {
        // An unknown language is not worth an error: the plain block stays.
        if (!cancelled) setHighlighted(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, language, key]);

  const codeClass =
    "chat-code-block__code w-full overflow-x-auto text-[13px] leading-relaxed";

  return (
    <div
      data-slot="code-block"
      className={cn(
        "my-2 flex w-full flex-col overflow-clip rounded-xl bg-surface-secondary text-surface-secondary-foreground",
        className,
      )}
    >
      {showHeader ? (
        <div data-slot="code-block-header" className="flex items-center justify-between gap-2 px-3 pt-2">
          <span className="text-xs uppercase text-muted">{language}</span>
          <CopyCodeButton code={code} />
        </div>
      ) : null}
      {highlighted?.key === key ? (
        <div
          data-slot="code-block-code"
          className={codeClass}
          dangerouslySetInnerHTML={{ __html: highlighted.html }}
        />
      ) : (
        <div data-slot="code-block-code" className={codeClass}>
          <pre>
            <code>{code}</code>
          </pre>
        </div>
      )}
    </div>
  );
}

/** Copy icon that turns into a check for two seconds after a copy. */
function CopyCodeButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  return (
    <Button
      isIconOnly
      size="sm"
      variant="ghost"
      aria-label="Copy code"
      className="size-6 min-w-0 shrink-0 text-muted hover:text-foreground"
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
          // Clipboard refused (permissions, insecure origin): nothing to say.
        }
      }}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </Button>
  );
}
