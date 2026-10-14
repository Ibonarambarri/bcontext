"use client";

/**
 * Shared "prolonged hover" dwell timer for inline card/row expansion on the
 * list and board surfaces. A ~550ms delay (the usual hover-card threshold)
 * drives local expand/collapse state instead of an overlay: expands after
 * the dwell elapses, collapses immediately on mouse leave, and cleans up its
 * timer on unmount so a stale hover never fires after the component is gone.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export function useHoverDwell(delayMs = 550) {
  const [expanded, setExpanded] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const onMouseEnter = useCallback(() => {
    clearTimer();
    timerRef.current = setTimeout(() => setExpanded(true), delayMs);
  }, [clearTimer, delayMs]);

  const onMouseLeave = useCallback(() => {
    clearTimer();
    setExpanded(false);
  }, [clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  return { expanded, onMouseEnter, onMouseLeave } as const;
}
