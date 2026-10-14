"use client";

import { Blobatar } from "@blobatar/react";
import "blobatar/motion.css";
import { cn } from "@bcontext-dev/contract/utils";

/**
 * A person, as a face: a blobatar drawn from their account id.
 *
 * Used wherever a person is shown next to their name — the account row in
 * the sidebar and the hub, the account modal, the org roster and the
 * presence chips in the editor and the inspector — so one person is the
 * same creature everywhere and two colleagues are told apart before either
 * name is read.
 *
 * The backdrop is transparent on purpose: the silhouette *is* the avatar,
 * sitting straight on the page in light and dark. A disc behind it would
 * have to match the surface it lands on, and there is no disc to match.
 *
 * Seeded by the id rather than the name so two people called the same get
 * their own face and renaming yourself keeps it. The email stands in for a
 * roster row whose account is gone (agents whose owner left); a fixed word
 * is the last resort so nobody renders faceless.
 */
export function PersonAvatar({
  user,
  size = 32,
  pending = false,
  animate,
  className,
}: {
  user: { id?: string | null; email?: string | null } | null | undefined;
  size?: number;
  /**
   * The person is still being read. The tile keeps its place and its shape
   * and says nothing, instead of a placeholder face that is swapped for the
   * real one a moment later.
   */
  pending?: boolean;
  /**
   * `hover` wakes the face under the pointer (or under a `.avatar-wake` row,
   * see globals.css); `always` idles it continuously — for the one face on a
   * profile header, not for a list. Off, it renders as a single `<img>`.
   */
  animate?: "hover" | "always";
  className?: string;
}) {
  if (pending || !user) {
    return (
      <span
        aria-hidden="true"
        className={cn("shrink-0 animate-pulse rounded-full bg-[var(--paper-3)]", className)}
        style={{ width: size, height: size }}
      />
    );
  }
  const seed = user.id ?? user.email ?? "somebody";
  const classes = cn("shrink-0", className);
  return animate ? (
    <Blobatar
      name={seed}
      size={size}
      traits={BLOBATAR_TRAITS}
      animate={animate}
      aria-hidden="true"
      className={classes}
    />
  ) : (
    <Blobatar name={seed} size={size} traits={BLOBATAR_TRAITS} alt="" aria-hidden="true" className={classes} />
  );
}

/**
 * The same face has to read on the light paper and on the dark one, and two
 * of blobatar's six swatches do not: the near-white "pale neutral" fades
 * into the light theme and the "ink" body fades into the dark one, leaving a
 * pair of floating eyes. The id still picks among the four that clear both —
 * pastel, mid, deep, bright — and every other axis stays free.
 */
export const BLOBATAR_TRAITS = { tone: [0.1, 0.5, 0.7, 0.87] };
