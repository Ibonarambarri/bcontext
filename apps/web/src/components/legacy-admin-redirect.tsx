"use client";

/**
 * Client-side redirect for the retired `/agents` and `/connections` routes
 * (their `page.tsx` files render only this). The destination depends on the
 * old `?tab=` query and the hash, which only the browser has — hence a
 * client component rather than a server `redirect()`. The mapping lives in
 * `legacyAdminDestination` (`@/lib/view-shell`).
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { legacyAdminDestination, type LegacyAdminSurface } from "@/lib/view-shell";
import { type WorkspaceAddress } from "@/web/workspace-url";

export function LegacyAdminRedirect({ workspace, source }: { workspace: WorkspaceAddress; source: LegacyAdminSurface }) {
  const router = useRouter();
  useEffect(() => {
    const destination = legacyAdminDestination(workspace, source, new URLSearchParams(window.location.search));
    router.replace(`${destination}${window.location.hash}` as Route);
  }, [router, source, workspace]);
  return <div className="flex h-full items-center justify-center text-[12px] text-[var(--ink-3)]" role="status">Opening the new workspace destination…</div>;
}
