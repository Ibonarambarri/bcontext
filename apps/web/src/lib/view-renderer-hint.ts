/**
 * Renderer hint per saved view — kills the double-skeleton jump.
 *
 * A view's renderer (graph, board, list…) is only known once the
 * views list resolves client-side, so a cold navigation would show the
 * generic list skeleton first and swap to the graph skeleton a beat later.
 * The shape of a view is extremely stable, so the last known renderer is
 * remembered in sessionStorage under every identity the route can use
 * (slug, system_key, id) and read synchronously by the route `loading.tsx`
 * and `ViewCanvas` — the correct skeleton renders from the first frame.
 *
 * sessionStorage on purpose: survives reloads within the tab, resets per
 * session, never leaks across users sharing a profile long-term.
 */

import { useSyncExternalStore } from "react";
import { workspaceApiRef, type WorkspaceAddress } from "@/web/workspace-url";

const PREFIX = "bx:view-renderer:";

export type ViewRendererHint = "graph" | "board" | "changes" | "list" | "table" | "browse" | "credentials" | "roadmap";

/* The `<org>~<workspace>` ref, not the slug: `acme/docs` and `globex/docs`
   are different workspaces and their views are not the same views. */
function keyFor(workspace: WorkspaceAddress, viewKey: string): string {
  return `${PREFIX}${workspaceApiRef(workspace)}:${viewKey}`;
}

/** Store the renderer under every key the route may use for this view; best-effort. */
export function rememberViewRenderer(
  workspace: WorkspaceAddress,
  viewKeys: ReadonlyArray<string | null | undefined>,
  renderer: string,
): void {
  try {
    for (const viewKey of viewKeys) {
      if (!viewKey) continue;
      window.sessionStorage.setItem(keyFor(workspace, viewKey), renderer);
    }
  } catch {
    // Storage unavailable (private mode, quota) — hint is best-effort.
  }
}

function readViewRendererHint(
  workspace: WorkspaceAddress | undefined,
  viewKey: string | undefined,
): ViewRendererHint | null {
  if (!workspace || !viewKey) return null;
  try {
    const value = window.sessionStorage.getItem(keyFor(workspace, viewKey));
    // A stale "timeline" hint (renderer retired 2026-07-21) simply misses
    // here and falls back to the generic skeleton.
    return value === "graph" || value === "board" || value === "changes" || value === "list" || value === "table" || value === "browse" || value === "credentials"
      ? value
      : null;
  } catch {
    return null;
  }
}

const subscribeNever = () => () => {};

/**
 * Hydration-safe hint read. The server cannot know the renderer, so SSR and
 * the hydration pass render the neutral fallback (`null`); the client
 * snapshot kicks in immediately after hydration. On client-side navigations
 * — the case where the double-skeleton flash actually lived — there is no
 * server pass at all and the hinted skeleton renders from the first frame.
 */
export function useViewRendererHint(
  workspace: WorkspaceAddress | undefined,
  viewKey: string | undefined,
): ViewRendererHint | null {
  return useSyncExternalStore(
    subscribeNever,
    () => readViewRendererHint(workspace, viewKey),
    () => null,
  );
}
