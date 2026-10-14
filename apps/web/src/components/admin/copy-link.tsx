"use client";

import { useState } from "react";
import { Button } from "@heroui/react";

/**
 * A link the admin is meant to send by hand: shown in full so it can be read
 * aloud or pasted anywhere, with one button that puts it on the clipboard.
 *
 * The link is always visible, never hidden behind the copy button: the
 * clipboard API fails silently in more places than people expect (insecure
 * origins, locked-down browsers), and the fallback has to be "select the
 * text" rather than "the link is gone".
 */
export function CopyLink({ url, label }: { url: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex w-full flex-wrap items-center gap-2">
      {label ? (
        <span className="font-mono text-app-xs uppercase tracking-widest text-[var(--fg-subtle)]">
          {label}
        </span>
      ) : null}
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg border border-[var(--border)] bg-[var(--bg-subtle)] px-3 py-2 font-mono text-app-xs text-[var(--fg-muted)]">
        {url}
      </code>
      <Button type="button" size="sm" variant="secondary" onPress={copy}>
        {copied ? "Copied" : "Copy link"}
      </Button>
    </div>
  );
}
