"use client";

/**
 * BoardTopScrollbar — a thin, always-on-top horizontal scrollbar for
 * kanban boards, so wide boards can be panned without scrolling to the
 * bottom edge first.
 *
 * Wrap the board root with it:
 *
 *   <BoardTopScrollbar>
 *     <Kanban hideScrollBar>…</Kanban>
 *   </BoardTopScrollbar>
 *
 * It finds the horizontal scroll container inside its children (the
 * Kanban root, `.kanban`, by default — override with
 * `scrollerSelector`) and renders a custom proportional thumb above it,
 * synced both ways: dragging the thumb (or clicking/keying the track)
 * scrolls the board, and scrolling the board — wheel, drag-near-edge
 * auto-scroll, keyboard — moves the thumb via the container's `scroll`
 * event. Only shown when there is real overflow (scrollWidth >
 * clientWidth); geometry math lives in `src/lib/board-scroll.ts`
 * (unit-tested). It never touches the wrapped board's DnD or state.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "@bcontext-dev/contract/utils";
import {
  clamp,
  computeThumb,
  scrollLeftForThumbOffset,
  thumbOffsetFor,
  type HThumbMetrics,
} from "@/lib/board-scroll";

const KEY_SCROLL_STEP = 160;

export function BoardTopScrollbar({
  children,
  className,
  scrollerSelector = ".kanban",
  label = "Scroll board horizontally",
}: {
  children: ReactNode;
  className?: string;
  /** CSS selector of the horizontal scroll container inside `children`. */
  scrollerSelector?: string;
  label?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const metricsRef = useRef<HThumbMetrics | null>(null);
  const dragRef = useRef<{ startX: number; startOffset: number } | null>(null);
  const [visible, setVisible] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fallbackScrollerId = useId();
  const [scrollerId, setScrollerId] = useState<string | undefined>(undefined);

  const syncThumb = useCallback(() => {
    const scroller = scrollerRef.current;
    const thumb = thumbRef.current;
    const track = trackRef.current;
    const m = metricsRef.current;
    if (!scroller || !thumb || !m) return;
    const offset = thumbOffsetFor(scroller.scrollLeft, m);
    thumb.style.left = `${offset}px`;
    track?.setAttribute(
      "aria-valuenow",
      String(m.maxScrollLeft > 0 ? Math.round((scroller.scrollLeft / m.maxScrollLeft) * 100) : 0),
    );
  }, []);

  /** Re-measure overflow + thumb geometry (idempotent, cheap). */
  const refresh = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const overflow = scroller.scrollWidth > scroller.clientWidth + 1;
    setVisible(overflow);
    const track = trackRef.current;
    // While hidden (display:none) the track has no width — metrics are
    // recomputed by the `visible` effect right after it appears.
    const m = overflow && track
      ? computeThumb({
          scrollWidth: scroller.scrollWidth,
          clientWidth: scroller.clientWidth,
          trackWidth: track.clientWidth,
        })
      : null;
    metricsRef.current = m;
    if (m && thumbRef.current) {
      thumbRef.current.style.width = `${m.thumbWidth}px`;
      syncThumb();
    }
  }, [syncThumb]);

  // Locate the scroller and keep everything in sync with it.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const scroller = wrap.querySelector<HTMLElement>(scrollerSelector);
    scrollerRef.current = scroller;
    if (!scroller) return;
    if (!scroller.id) scroller.id = fallbackScrollerId;
    setScrollerId(scroller.id);

    refresh();
    const onScroll = () => syncThumb();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(refresh);
    ro.observe(scroller);
    // Column count changes (grouping, first load) change scrollWidth
    // without resizing the scroller itself.
    const mo = new MutationObserver(refresh);
    mo.observe(scroller, { childList: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      ro.disconnect();
      mo.disconnect();
      scrollerRef.current = null;
    };
  }, [scrollerSelector, refresh, syncThumb, fallbackScrollerId]);

  // The track only gains layout after it becomes visible — measure then.
  useEffect(() => {
    if (visible) refresh();
  }, [visible, refresh]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const scroller = scrollerRef.current;
    const track = trackRef.current;
    const m = metricsRef.current;
    if (!scroller || !track || !m || e.button !== 0) return;
    e.preventDefault();
    try {
      track.setPointerCapture(e.pointerId);
    } catch {
      // Capture is best-effort (e.g. synthetic events in tests); the
      // move/up handlers on the track still work without it.
    }
    const rect = track.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const currentOffset = thumbOffsetFor(scroller.scrollLeft, m);
    let startOffset = currentOffset;
    if (x < currentOffset || x > currentOffset + m.thumbWidth) {
      // Click on the rail: jump so the thumb centers under the pointer,
      // then keep dragging from there.
      startOffset = clamp(x - m.thumbWidth / 2, 0, m.maxThumbOffset);
      scroller.scrollLeft = scrollLeftForThumbOffset(startOffset, m);
    }
    dragRef.current = { startX: e.clientX, startOffset };
    setDragging(true);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const scroller = scrollerRef.current;
    const m = metricsRef.current;
    if (!drag || !scroller || !m) return;
    scroller.scrollLeft = scrollLeftForThumbOffset(
      drag.startOffset + (e.clientX - drag.startX),
      m,
    );
  }, []);

  const endDrag = useCallback(() => {
    dragRef.current = null;
    setDragging(false);
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const scroller = scrollerRef.current;
    const m = metricsRef.current;
    if (!scroller || !m) return;
    let delta = 0;
    if (e.key === "ArrowLeft") delta = -KEY_SCROLL_STEP;
    else if (e.key === "ArrowRight") delta = KEY_SCROLL_STEP;
    else if (e.key === "Home") delta = -m.maxScrollLeft;
    else if (e.key === "End") delta = m.maxScrollLeft;
    else return;
    e.preventDefault();
    scroller.scrollBy({ left: delta, behavior: "smooth" });
  }, []);

  return (
    <div ref={wrapRef} className={className}>
      <div
        ref={trackRef}
        role="scrollbar"
        aria-orientation="horizontal"
        aria-label={label}
        aria-controls={scrollerId}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={0}
        tabIndex={visible ? 0 : -1}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        className={cn(
          "group/hscroll relative mb-2 h-2.5 w-full cursor-pointer touch-none select-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40",
          !visible && "hidden",
        )}
      >
        <div className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-[var(--line)]/60" />
        <div
          ref={thumbRef}
          className={cn(
            "absolute top-1/2 h-[5px] -translate-y-1/2 rounded-full bg-[var(--ink-3)]/50 transition-[height,background-color] duration-150 group-hover/hscroll:h-[7px] group-hover/hscroll:bg-[var(--ink-3)]/80",
            dragging && "h-[7px] bg-[var(--ink-3)]/90",
          )}
        />
      </div>
      {children}
    </div>
  );
}
