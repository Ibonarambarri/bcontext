"use client";

import { useId } from "react";

/**
 * The Nexos mark: a team of faces — the sidebar row's icon and the shell
 * header's title icon for the Nexos section.
 *
 * The general Nexo stands in front, in the workspace accent like its avatar
 * everywhere else (`nexo/nexo-avatar.tsx`); two specialists peek out behind
 * it, one on each side, in two tag hues so they read as different creatures
 * the way the blobatars on the Nexos cards do. A gap is cut around the front
 * face and every eye is cut out of its body rather than painted on, so the
 * row's own background — paper, hover, current — shows through and the mark
 * stays legible in both themes without a colour of its own for the eyes.
 *
 * Colour only: unlike the lucide icons beside it, it ignores `currentColor`.
 * The row's idle/hover/current states are in globals.css (`.nexos-mark`).
 *
 * Hand-drawn, dependency-free SVG at icon size: this renders inside the
 * workspace shell, which is on a gzip budget
 * (`scripts/check-performance-budgets.mjs`), so the blobatar package the
 * cards use is not an option here.
 */
export function NexosMark({ size = 16, className }: { size?: number; className?: string }) {
  // Two masks per instance, and the mark renders more than once on a page
  // (the nav row, the view header): a shared literal id would have every
  // instance reach for the first one in the document.
  const id = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      className={className ? `nexos-mark ${className}` : "nexos-mark"}
    >
      <mask id={`${id}b`} maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32">
        <rect width="32" height="32" fill="#fff" />
        {/* The gap around the front face, then the back faces' eyes, both
            glancing outward. */}
        <circle cx="16" cy="20" r="10.4" />
        <rect x="2.6" y="8.4" width="2.6" height="4.2" rx="1.3" />
        <rect x="5.9" y="8.4" width="2.6" height="4.2" rx="1.3" />
        <rect x="23.5" y="8.4" width="2.6" height="4.2" rx="1.3" />
        <rect x="26.8" y="8.4" width="2.6" height="4.2" rx="1.3" />
      </mask>
      <mask id={`${id}f`} maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32">
        <rect width="32" height="32" fill="#fff" />
        <rect x="11.4" y="15.6" width="3.6" height="5.6" rx="1.8" />
        <rect x="17" y="15.6" width="3.6" height="5.6" rx="1.8" />
      </mask>
      <g mask={`url(#${id}b)`}>
        <circle cx="7.6" cy="13" r="7.4" fill="oklch(var(--tag-l) var(--tag-c) 35)" />
        <circle cx="24.4" cy="13" r="7.4" fill="oklch(var(--tag-l) var(--tag-c) 160)" />
      </g>
      <circle cx="16" cy="20" r="9" fill="var(--accent)" mask={`url(#${id}f)`} />
    </svg>
  );
}
