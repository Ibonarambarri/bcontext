/**
 * Error boundary for the node page. Narrower than the workspace one so a node
 * that fails to render leaves the sidebar and the rest of the shell usable.
 */
"use client";

import { useEffect } from "react";

export default function NodeError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      console.error(error);
    }
  }, [error]);

  return (
    <div className="flex h-full items-center justify-center px-10 py-12">
      <div className="w-full max-w-md rounded-md border border-[var(--border)] bg-[var(--bg-subtle)] p-6">
        <p className="text-[11px] uppercase tracking-widest text-[var(--fg-subtle)]">
          Error
        </p>
        <h2 className="mt-1 text-base font-semibold tracking-tight">
          Couldn&apos;t load this page
        </h2>
        <p className="mt-2 text-xs text-[var(--fg-muted)]">
          Something went wrong while loading this node. You can retry or
          navigate elsewhere.
        </p>
        {error?.digest && (
          <p className="mt-2 font-mono text-[10px] text-[var(--fg-subtle)]">
            {error.digest}
          </p>
        )}
        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={() => reset()}
            className="rounded-md border border-[var(--border-strong)] bg-[var(--bg)] px-2.5 py-1 text-xs text-[var(--fg)] hover:bg-[var(--bg-muted)]"
          >
            Retry
          </button>
        </div>
      </div>
    </div>
  );
}
