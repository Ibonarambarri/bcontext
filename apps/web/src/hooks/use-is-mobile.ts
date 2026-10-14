"use client";

import { useEffect, useState } from "react";

/**
 * Tracks whether the viewport is below the `md` breakpoint (768px) — the line
 * where the desktop three-zone shell switches to a single column with the tree
 * and chat moved into slide-over drawers.
 *
 * SSR-safe: starts `false` so the server render matches a desktop layout, then
 * reconciles on mount. Components that branch on this should treat the first
 * client paint as authoritative (drawers are client-only chrome anyway).
 */
export function useIsMobile(query = "(max-width: 767px)"): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    const update = () => setIsMobile(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, [query]);

  return isMobile;
}
