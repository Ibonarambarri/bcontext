"use client";

/**
 * Client-side redirect for the retired `/browse` and `/nodes` workspace
 * routes (their `page.tsx` files render only this). Both land on the
 * workspace home; the query string and hash travel along so old bookmarks
 * with `?inspect=` or a block anchor still open what they pointed at. It has
 * to run on the client because the hash never reaches the server.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { legacyBrowseDestination } from "@/lib/view-shell";
import { type WorkspaceAddress } from "@/web/workspace-url";

export function LegacyBrowseRedirect({ workspace }: { workspace: WorkspaceAddress }) {
  const router = useRouter();
  useEffect(() => {
    const destination = legacyBrowseDestination(workspace, new URLSearchParams(window.location.search));
    router.replace(`${destination}${window.location.hash}` as Route);
  }, [router, workspace]);
  return <div role="status" className="flex h-full items-center justify-center text-[12px] text-[var(--ink-3)]">Opening Overview…</div>;
}
