"use client";

/**
 * Nexo's face.
 *
 * A soft blob with two eyes, in the spirit of the avatars bloub
 * (https://bloub.vercel.app) generates — drawn here rather than exported so it
 * can do what an exported asset cannot: watch the cursor, blink, flinch when
 * you poke it, and take the workspace's accent.
 *
 * Colour is nearly not a prop. The eyes are `var(--accent-ink)` and the body
 * is `var(--accent)`, so the avatar follows whatever accent the workspace has
 * chosen — including a live theme change — with no asset to re-export.
 *
 * `gradient` is the one exception, and it is for the large renderings: the
 * launcher and the panel header, where the face is a logo rather than a bullet
 * and gets the workspace's own gradient, the same two colours as the tile in
 * the top-left corner. At 16px in a message list a gradient is a slightly
 * uneven circle, so those keep the flat accent.
 *
 * Cursor tracking is opt-in (`tracksCursor`): it costs a rect measurement per
 * frame, so the launcher and the panel header watch you while the avatar on
 * every message of a long thread does not. All motion stops under
 * `prefers-reduced-motion`.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { cn } from "@bcontext-dev/contract/utils";
import type { WorkspaceGradient } from "@bcontext-dev/contract/workspace-gradients";
import { subscribeToPointer } from "@/lib/nexo/pointer";

/**
 * What the face is doing. `asking` tilts like a question, `error` crosses the
 * eyes out — the two states a chat usually communicates with a red banner and
 * a spinner respectively.
 */
export type NexoMood = "idle" | "thinking" | "speaking" | "asking" | "error";

/** How far the eyes travel from centre, in viewBox units (the body is 32). */
const MAX_EYE_TRAVEL = 2.4;
/** Distance in px at which the gaze is fully deflected. */
const FULL_DEFLECTION_AT = 220;
/** Length of the poke reaction. Must match `nexo-boing` in globals.css. */
const REACTION_MS = 520;

export function NexoAvatar({
  size = 24,
  mood = "idle",
  tracksCursor = false,
  gradient,
  className,
}: {
  size?: number;
  mood?: NexoMood;
  tracksCursor?: boolean;
  /** Paint the body with a workspace gradient instead of the flat accent. */
  gradient?: WorkspaceGradient | null;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const gradientId = useId();
  const [reacting, setReacting] = useState(false);
  const reactionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!tracksCursor) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    return subscribeToPointer((x, y) => {
      const el = ref.current;
      if (!el) return;
      const box = el.getBoundingClientRect();
      if (box.width === 0) return;
      const dx = x - (box.left + box.width / 2);
      const dy = y - (box.top + box.height / 2);
      const distance = Math.hypot(dx, dy) || 1;
      // Deflection grows with distance and then saturates: a cursor across the
      // screen and one just outside the avatar should not look the same, but
      // past arm's length the difference stops mattering.
      const travel = MAX_EYE_TRAVEL * Math.min(1, distance / FULL_DEFLECTION_AT);
      el.style.setProperty("--nexo-eye-x", `${((dx / distance) * travel).toFixed(2)}px`);
      // Less vertical travel than horizontal: the eyes have less room to move up
      // and down before they crowd the edge of the body.
      el.style.setProperty("--nexo-eye-y", `${((dy / distance) * travel * 0.7).toFixed(2)}px`);
    });
  }, [tracksCursor]);

  useEffect(
    () => () => {
      if (reactionTimer.current) clearTimeout(reactionTimer.current);
    },
    [],
  );

  /** Poke it and it flinches. Pointer-down, not click, so it feels immediate. */
  const react = useCallback(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    if (reactionTimer.current) clearTimeout(reactionTimer.current);
    setReacting(false);
    // Next frame, so a second poke restarts the animation instead of being
    // swallowed by the still-running one.
    requestAnimationFrame(() => {
      setReacting(true);
      reactionTimer.current = setTimeout(() => setReacting(false), REACTION_MS);
    });
  }, []);

  return (
    <span
      ref={ref}
      data-nexo-avatar
      data-mood={mood}
      data-reacting={reacting ? "" : undefined}
      onPointerDown={react}
      aria-hidden="true"
      className={cn("nexo-avatar inline-flex shrink-0", className)}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 32 32" width={size} height={size} role="presentation">
        {gradient ? (
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor={gradient.from} />
              <stop offset="100%" stopColor={gradient.to} />
            </linearGradient>
          </defs>
        ) : null}
        <g className="nexo-avatar__body">
          {/* A plain round body. The character is in the eyes and the timing,
              not in the silhouette — a fussier outline only costs legibility
              at 16px, which is where this thing spends most of its life. */}
          <path
            d="M16 1.6c8.2 0 14.4 5.9 14.4 14.4S24.2 30.4 16 30.4 1.6 24.2 1.6 16 7.8 1.6 16 1.6Z"
            fill={gradient ? `url(#${gradientId})` : "var(--accent)"}
          />
          {/* Four nested groups, each owning exactly one transform so none of
              them clobbers another: gaze follows the cursor, tilt is static,
              squeeze is the poke, blink is per eye. */}
          <g className="nexo-avatar__gaze">
            <g className="nexo-avatar__eyes" fill={gradient ? "white" : "var(--accent-ink)"}>
              <g transform="rotate(-8 16 15)">
                <rect className="nexo-avatar__eye" x="8.9" y="10.2" width="5.3" height="8" rx="2.65" />
                <rect
                  className="nexo-avatar__eye nexo-avatar__eye--right"
                  x="17.8"
                  y="10.2"
                  width="5.3"
                  height="8"
                  rx="2.65"
                />
              </g>
            </g>
            {/* Both eye sets are always in the DOM and CSS decides which one
                shows, so switching mood costs no re-render and no layout. */}
            <g
              className="nexo-avatar__crosses"
              stroke={gradient ? "white" : "var(--accent-ink)"}
              strokeWidth="2.1"
              strokeLinecap="round"
            >
              <path d="M9.4 11.6 13.6 16M13.6 11.6 9.4 16" />
              <path d="M18.3 11.6 22.5 16M22.5 11.6 18.3 16" />
            </g>
          </g>
        </g>
      </svg>
    </span>
  );
}
