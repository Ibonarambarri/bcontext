"use client";

/**
 * A Nexo, as a face.
 *
 * Specialists are blobatars seeded by their name, so "Marketing" is the same
 * creature on its card, in its header and beside every message it writes, and
 * two Nexos are told apart before either name is read. Renaming one gives it
 * a new face on purpose: the name is its identity to the team.
 *
 * The general Nexo keeps the face it already has everywhere else — the
 * accent blob of the launcher and the panel (`nexo/nexo-avatar.tsx`) — because
 * it is the same assistant, now standing at the head of a team.
 *
 * Mounted by the Nexos grid, the Nexo detail header and the specialist chat.
 */
import { Blobatar } from "@blobatar/react";
import "blobatar/motion.css";
import { cn } from "@bcontext-dev/contract/utils";
import { BLOBATAR_TRAITS } from "../person-avatar";
import { NexoAvatar } from "../nexo/nexo-avatar";

export function NexoFace({
  name,
  general = false,
  size = 40,
  animate,
  muted = false,
  className,
}: {
  name: string;
  general?: boolean;
  size?: number;
  /** `hover` wakes it under the pointer (a card); `always` for the one big face of a header. */
  animate?: "hover" | "always";
  /** Paused: the face stays, drained of colour, so the grid still reads as the same team. */
  muted?: boolean;
  className?: string;
}) {
  const classes = cn("shrink-0", muted && "opacity-55 grayscale", className);
  if (general) {
    return <NexoAvatar size={size} tracksCursor={animate === "always"} className={classes} />;
  }
  const seed = name.trim() || "nexo";
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
