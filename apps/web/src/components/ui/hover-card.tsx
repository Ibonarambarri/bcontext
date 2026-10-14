"use client";

/**
 * HoverCard — a non-modal floating card anchored to a trigger, for previews
 * that appear on hover and never take focus. The tag graph uses it,
 * controlled, with an invisible 1px trigger moved to the hovered node.
 *
 * Opens after `openDelay` when a mouse enters the trigger (immediately on
 * keyboard focus) and closes after `closeDelay` once the pointer has left
 * both the trigger and the card, so the pointer can travel into the card.
 * Escape closes it. Positioning is React Aria's Popover with `isNonModal`:
 * no focus trap, no underlay, the page below stays interactive.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import { OverlayArrow, Popover, type PopoverProps } from "react-aria-components";
import { cn } from "@bcontext-dev/contract/utils";

interface HoverCardState {
  isOpen: boolean;
  open: (now?: boolean) => void;
  close: (now?: boolean) => void;
  cancelClose: () => void;
  triggerRef: RefObject<HTMLSpanElement | null>;
}

const HoverCardContext = createContext<HoverCardState | null>(null);

function useHoverCard(): HoverCardState {
  const ctx = useContext(HoverCardContext);
  if (!ctx) throw new Error("HoverCard parts must be rendered inside <HoverCard>");
  return ctx;
}

function Root({
  open: controlled,
  defaultOpen = false,
  onOpenChange,
  openDelay = 700,
  closeDelay = 300,
  children,
}: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  openDelay?: number;
  closeDelay?: number;
  children?: ReactNode;
}) {
  const [uncontrolled, setUncontrolled] = useState(defaultOpen);
  const isOpen = controlled ?? uncontrolled;
  const setOpen = useCallback(
    (next: boolean) => {
      if (controlled === undefined) setUncontrolled(next);
      onOpenChange?.(next);
    },
    [controlled, onOpenChange],
  );
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const clearTimers = useCallback(() => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
  }, []);
  useEffect(() => clearTimers, [clearTimers]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clearTimers();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [clearTimers, isOpen, setOpen]);

  const value = useMemo<HoverCardState>(
    () => ({
      isOpen,
      triggerRef,
      open: (now = false) => {
        clearTimers();
        if (now || openDelay <= 0) setOpen(true);
        else openTimer.current = setTimeout(() => setOpen(true), openDelay);
      },
      close: (now = false) => {
        clearTimers();
        if (now || closeDelay <= 0) setOpen(false);
        else closeTimer.current = setTimeout(() => setOpen(false), closeDelay);
      },
      cancelClose: () => clearTimeout(closeTimer.current),
    }),
    [clearTimers, closeDelay, isOpen, openDelay, setOpen],
  );
  return <HoverCardContext.Provider value={value}>{children}</HoverCardContext.Provider>;
}

function Trigger({ className, children, onPointerEnter, onPointerLeave, onFocus, onBlur, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  const { open, close, triggerRef } = useHoverCard();
  return (
    <span
      ref={triggerRef}
      data-slot="hover-card-trigger"
      className={cn("inline-flex", className)}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") open();
        onPointerEnter?.(event);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") close();
        onPointerLeave?.(event);
      }}
      onFocus={(event) => {
        open(true);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        close();
        onBlur?.(event);
      }}
      {...rest}
    >
      {children}
    </span>
  );
}

function Content({
  className,
  placement = "top",
  offset = 8,
  children,
}: {
  className?: string;
  placement?: PopoverProps["placement"];
  offset?: number;
  children?: ReactNode;
}) {
  const { isOpen, close, cancelClose, triggerRef } = useHoverCard();
  return (
    <Popover
      isNonModal
      isOpen={isOpen}
      onOpenChange={(next) => {
        if (!next) close(true);
      }}
      triggerRef={triggerRef}
      placement={placement}
      offset={offset}
      data-slot="hover-card-content"
      onPointerEnter={cancelClose}
      onPointerLeave={() => close()}
      className={cn(
        "max-w-sm rounded-[calc(var(--radius)*2)] bg-overlay p-4 shadow-overlay outline-none",
        "data-[entering]:animate-in data-[entering]:fade-in data-[entering]:zoom-in-95 data-[entering]:duration-150",
        "data-[exiting]:animate-out data-[exiting]:fade-out data-[exiting]:zoom-out-95 data-[exiting]:duration-100",
        "motion-reduce:animate-none",
        className,
      )}
    >
      {children}
    </Popover>
  );
}

function Arrow({ className }: { className?: string }) {
  return (
    <OverlayArrow
      data-slot="hover-card-arrow"
      className={cn(
        "block [&_svg]:fill-overlay data-[placement=bottom]:[&_svg]:rotate-180 data-[placement=left]:[&_svg]:-rotate-90 data-[placement=right]:[&_svg]:rotate-90",
        className,
      )}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M0 0C5.48483 8 6.5 8 12 0Z" />
      </svg>
    </OverlayArrow>
  );
}

export const HoverCard = Object.assign(Root, { Trigger, Content, Arrow });
