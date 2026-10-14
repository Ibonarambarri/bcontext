"use client";

import { createContext, useContext, useState } from "react";
import { createPortal } from "react-dom";

/**
 * The shell owns one chrome row per surface (sidebar trigger + view title,
 * `workspace-shell.tsx`), and the active view is rendered as its child — so a
 * view that needs controls up there has nowhere to put them without growing a
 * second header bar of its own. This is that missing slot: the shell mounts
 * the target element, views portal into it.
 *
 * Used by the Brain graph's Knowledge/Tags focus switcher, which has to sit
 * next to the title rather than float over the canvas — the canvas already
 * carries the layer toggles and camera controls.
 */
const ViewHeaderSlotContext = createContext<HTMLElement | null>(null);

/** Shell side: makes the mounted header element available to the views below. */
export function ViewHeaderSlotProvider({
  target,
  children,
}: {
  target: HTMLElement | null;
  children: React.ReactNode;
}) {
  return <ViewHeaderSlotContext.Provider value={target}>{children}</ViewHeaderSlotContext.Provider>;
}

/** Ref callback + element for the shell side of the slot. */
export function useViewHeaderSlotTarget() {
  return useState<HTMLElement | null>(null);
}

/**
 * Render `children` into the shell's header row. Renders nothing until the
 * target exists (first client paint), so it is safe during SSR.
 */
export function ViewHeaderSlot({ children }: { children: React.ReactNode }) {
  const target = useContext(ViewHeaderSlotContext);
  if (!target) return null;
  return createPortal(children, target);
}
