"use client";

/**
 * The floating window every "open one thing" surface uses over the active
 * view: the node panel (`node-floating-panel.tsx`) and the conflict panel
 * (`conflicts/conflict-panel.tsx`). One module so they cannot drift — same
 * geometry (half of the surface by default, all of it when expanded),
 * same edge shared with Nexo through `--nexo-w`, same border, shadow,
 * slide-in and Esc. A panel that looked different from the node panel is
 * how the conflict drawer came to exist; this is what replaced it.
 *
 * Positioning is `absolute` against the shell's "Active page" region. The
 * node panel is the region's own child; a view that lives inside a scroll
 * container (every dashboard) has to portal out of it, which is what
 * `portal` does with the root the shell publishes through
 * `FloatingPanelRootProvider`.
 *
 * Esc closes the panel opened last, not every open one: a node opened from
 * inside a conflict sits on top of it, and Esc must peel that one first.
 * That is the small stack below; Alt+←/→ and other keys stay with each
 * panel.
 */

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button, Surface, Tooltip } from "@heroui/react";
import { cn } from "@bcontext-dev/contract/utils";

const FloatingPanelRootContext = createContext<HTMLElement | null>(null);

/** Shell side: publishes the "Active page" element the panels float over. */
export function FloatingPanelRootProvider({ root, children }: { root: HTMLElement | null; children: React.ReactNode }) {
  return <FloatingPanelRootContext.Provider value={root}>{children}</FloatingPanelRootContext.Provider>;
}

/** Ref callback + element for the shell side of the root. */
export function useFloatingPanelRootTarget() {
  return useState<HTMLElement | null>(null);
}

// Close callbacks of the panels currently open, oldest first. Esc pops the
// newest. Module-level on purpose: the panels do not share a parent.
const openStack: Array<() => void> = [];
let escListener: ((event: KeyboardEvent) => void) | null = null;

function syncEscListener() {
  if (openStack.length > 0 && !escListener) {
    escListener = (event) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      const typing = Boolean(target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable));
      if (typing) return;
      const top = openStack[openStack.length - 1];
      if (!top) return;
      event.preventDefault();
      top();
    };
    window.addEventListener("keydown", escListener);
  } else if (openStack.length === 0 && escListener) {
    window.removeEventListener("keydown", escListener);
    escListener = null;
  }
}

export type FloatingPanelSize = "half" | "full";

export function FloatingPanel({
  open,
  size,
  label,
  onClose,
  portal = false,
  className,
  children,
  ...rest
}: {
  open: boolean;
  size: FloatingPanelSize;
  label: string;
  onClose: () => void;
  /** Render into the shell's region instead of in place (views inside a scroll container). */
  portal?: boolean;
  className?: string;
  children: React.ReactNode;
} & Record<`data-${string}`, string | undefined>) {
  const root = useContext(FloatingPanelRootContext);

  // The stack entry is one stable function per panel instance that reads the
  // latest onClose: callers pass inline closures, and re-registering on every
  // render would move a panel back to the top of the stack while another one
  // sits above it — Esc would then close the wrong panel.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const entryRef = useRef<() => void>(() => onCloseRef.current());

  useEffect(() => {
    if (!open) return;
    const entry = entryRef.current;
    openStack.push(entry);
    syncEscListener();
    return () => {
      const index = openStack.lastIndexOf(entry);
      if (index >= 0) openStack.splice(index, 1);
      syncEscListener();
    };
  }, [open]);

  const panel = (
    <Surface
      variant="default"
      role="dialog"
      aria-label={label}
      aria-hidden={!open}
      data-floating-panel
      data-size={size}
      {...rest}
      className={cn(
        "absolute flex flex-col overflow-hidden rounded-xl border border-[var(--line)] p-0 shadow-xl transition-[transform,opacity,width,inset] duration-200 ease-out",
        size === "full"
          ? "inset-y-2 left-2 right-[calc(var(--nexo-w,0px)+0.5rem)] md:inset-y-3 md:left-3 md:right-[calc(var(--nexo-w,0px)+0.75rem)]"
          : "inset-y-3 right-[calc(var(--nexo-w,0px)+0.75rem)] w-[min(calc(50%-18px),calc(100%-var(--nexo-w,0px)-1.5rem))]",
        open ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-4 opacity-0",
        className,
      )}
    >
      {children}
    </Surface>
  );

  if (!portal) return panel;
  // Nothing to float over until the shell has mounted the region.
  if (!root) return null;
  return createPortal(panel, root);
}

/** One icon button of a panel's header toolbar, tooltip included. */
export function FloatingPanelAction({ label, disabled = false, onPress, children }: { label: string; disabled?: boolean; onPress: () => void; children: React.ReactNode }) {
  return (
    <Tooltip delay={400}>
      <Button isIconOnly variant="ghost" isDisabled={disabled} onPress={onPress} aria-label={label} className="icon-btn">
        {children}
      </Button>
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip>
  );
}
