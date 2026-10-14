/**
 * Pure math for the boards' top horizontal scrollbar
 * (`src/components/board-top-scrollbar.tsx`): maps a scroll container's
 * scrollLeft to a proportional thumb on a fixed-width track and back.
 * Framework-free so it can be unit-tested without DOM.
 */

export interface HThumbMetrics {
  /** Thumb width in px (proportional, floored at minThumbWidth). */
  thumbWidth: number;
  /** Max thumb left offset in px (trackWidth - thumbWidth). */
  maxThumbOffset: number;
  /** Max scrollLeft of the mirrored container (scrollWidth - clientWidth). */
  maxScrollLeft: number;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Thumb geometry for a scroller/track pair, or `null` when there is no
 * real overflow (or the track hasn't been laid out yet) — the caller
 * hides the bar in that case.
 */
export function computeThumb(args: {
  scrollWidth: number;
  clientWidth: number;
  trackWidth: number;
  minThumbWidth?: number;
}): HThumbMetrics | null {
  const { scrollWidth, clientWidth, trackWidth, minThumbWidth = 40 } = args;
  // +1 tolerates sub-pixel rounding so a 0.5px "overflow" doesn't flash a bar.
  if (trackWidth <= 0 || scrollWidth <= clientWidth + 1) return null;
  const thumbWidth = clamp(
    (clientWidth / scrollWidth) * trackWidth,
    Math.min(minThumbWidth, trackWidth),
    trackWidth,
  );
  return {
    thumbWidth,
    maxThumbOffset: Math.max(0, trackWidth - thumbWidth),
    maxScrollLeft: scrollWidth - clientWidth,
  };
}

/** Thumb left offset for a given scrollLeft. */
export function thumbOffsetFor(scrollLeft: number, m: HThumbMetrics): number {
  if (m.maxScrollLeft <= 0 || m.maxThumbOffset <= 0) return 0;
  return clamp(scrollLeft / m.maxScrollLeft, 0, 1) * m.maxThumbOffset;
}

/** scrollLeft for a given (unclamped) thumb offset — inverse of the above. */
export function scrollLeftForThumbOffset(offset: number, m: HThumbMetrics): number {
  if (m.maxThumbOffset <= 0) return 0;
  return (clamp(offset, 0, m.maxThumbOffset) / m.maxThumbOffset) * m.maxScrollLeft;
}
