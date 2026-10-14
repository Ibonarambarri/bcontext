"use client";

/**
 * A spotlight: the page dims except for one element, and a popover next to
 * it says why it matters. Used by the "Getting started" tour, one step at
 * a time; `getting-started.tsx` decides which element and what to say.
 *
 * Built from what the app already has instead of a tour library: the
 * popover is HeroUI's (react-aria underneath — positioning, flipping,
 * Escape, focus) anchored by `triggerRef` to whatever element the selector
 * finds, and the dimming is one fixed SVG with a rounded hole cut by a
 * mask. Nothing here is persisted; the checklist's state is the API's.
 *
 * The overlay does not take pointer events: the ringed element stays
 * clickable, so "go there" can be a real click on the real thing. The
 * popover is non-modal for the same reason — nothing is aria-hidden and
 * focus is not trapped; Escape and the buttons close it.
 *
 * The element is looked up by selector, not by ref, because it lives in a
 * different subtree (the sidebar) and may not be mounted yet on the frame
 * the tour opens — a MutationObserver keeps looking for a short while. Its
 * rectangle is re-read on scroll, resize and layout changes so the hole
 * follows the sidebar being resized or the page reflowing.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Popover } from "@heroui/react";

/**
 * How long to keep looking for an element that is not in the DOM yet. Long
 * enough for the step's page to load (a route change plus a dynamic chunk)
 * before the step gives up and shows itself as a card instead.
 */
const FIND_TIMEOUT_MS = 8000;
/** Air between the element and the edge of the hole, in px. */
const RING_PADDING = 6;
const RING_RADIUS = 10;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The element a selector names, now or as soon as it appears — and again
 * if the page swaps it out (a list re-rendering its header, a modal
 * remounting the button). `missing` when the wait ran out: the sidebar is
 * a sheet on mobile and simply has no such element on screen.
 */
function useAnchor(selector: string): { element: HTMLElement | null; missing: boolean } {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    setMissing(false);
    let current: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const find = () => {
      const el = document.querySelector<HTMLElement>(selector);
      if (el === current) return;
      current = el;
      setElement(el);
      if (el && timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    find();
    const observer = new MutationObserver(() => {
      if (current && !current.isConnected) current = null;
      find();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    if (!current) {
      timer = setTimeout(() => setMissing(true), FIND_TIMEOUT_MS);
    }
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [selector]);

  return { element, missing };
}

/** The element's viewport rectangle, kept current while it is on screen. */
function useTrackedRect(element: HTMLElement | null): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);

  useLayoutEffect(() => {
    if (!element) {
      setRect(null);
      return;
    }
    let frame = 0;
    const measure = () => {
      frame = 0;
      const r = element.getBoundingClientRect();
      setRect((prev) =>
        prev && prev.x === r.x && prev.y === r.y && prev.width === r.width && prev.height === r.height
          ? prev
          : { x: r.x, y: r.y, width: r.width, height: r.height },
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
    measure();
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    resize.observe(document.body);
    window.addEventListener("resize", schedule);
    // Capture: the sidebar and the page scroll their own containers.
    document.addEventListener("scroll", schedule, true);
    document.addEventListener("transitionend", schedule, true);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      resize.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
      document.removeEventListener("transitionend", schedule, true);
    };
  }, [element]);

  return rect;
}

export function Spotlight({
  selector,
  placement = "right",
  onClose,
  children,
}: {
  /** What to ring, as a CSS selector (`[data-tour="nav-agents"]`). */
  selector: string;
  placement?: "right" | "left" | "top" | "bottom";
  /** Escape, the close button, or focus leaving the popover for good. */
  onClose: () => void;
  /** What the popover says; buttons included. */
  children: ReactNode;
}) {
  const { element, missing } = useAnchor(selector);
  const rect = useTrackedRect(element);
  const triggerRef = useRef<HTMLElement | null>(null);
  triggerRef.current = element;

  const hole = rect
    ? {
        x: rect.x - RING_PADDING,
        y: rect.y - RING_PADDING,
        width: rect.width + RING_PADDING * 2,
        height: rect.height + RING_PADDING * 2,
      }
    : null;

  return (
    <>
      <svg
        aria-hidden="true"
        data-tour-overlay=""
        className="pointer-events-none fixed inset-0 z-[900] h-full w-full motion-safe:transition-opacity"
        style={{ opacity: hole || missing ? 1 : 0 }}
      >
        <defs>
          <mask id="bx-spotlight-mask">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            {hole ? (
              <rect
                x={hole.x}
                y={hole.y}
                width={hole.width}
                height={hole.height}
                rx={RING_RADIUS}
                fill="black"
                className="motion-safe:[transition:x_180ms,y_180ms,width_180ms,height_180ms]"
              />
            ) : null}
          </mask>
        </defs>
        <rect x="0" y="0" width="100%" height="100%" fill="rgb(0 0 0 / 0.45)" mask="url(#bx-spotlight-mask)" />
        {hole ? (
          <rect
            x={hole.x}
            y={hole.y}
            width={hole.width}
            height={hole.height}
            rx={RING_RADIUS}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="1.5"
            className="motion-safe:[transition:x_180ms,y_180ms,width_180ms,height_180ms]"
          />
        ) : null}
      </svg>

      {element ? (
        // The root is what hands `Popover.Content` its styles (a context),
        // so it is here even though nothing inside it is the trigger: the
        // anchor is `triggerRef`, and `isOpen` on the root keeps the
        // trigger-less dialog open.
        <Popover
          isOpen
          onOpenChange={(open) => {
            if (!open) onClose();
          }}
        >
          <Popover.Content
            triggerRef={triggerRef}
            isNonModal
            placement={placement}
            offset={RING_PADDING + 10}
            className="z-[1000] w-[300px] max-w-[calc(100vw-32px)]"
          >
            <Popover.Dialog aria-label="Guide step">
              <Popover.Arrow />
              {children}
            </Popover.Dialog>
          </Popover.Content>
        </Popover>
      ) : missing ? (
        // No such element on this screen (the mobile sheet, a hidden aside):
        // the step still explains itself, as a card, where the eye already is.
        <div
          role="dialog"
          aria-label="Guide step"
          className="popover fixed bottom-4 left-1/2 z-[1000] w-[300px] max-w-[calc(100vw-32px)] -translate-x-1/2"
        >
          <div className="popover__dialog">{children}</div>
        </div>
      ) : null}
    </>
  );
}
