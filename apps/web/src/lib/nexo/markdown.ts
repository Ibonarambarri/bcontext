/**
 * Nexo's answers are Markdown with two things plain Markdown does not have:
 * `[n]` citation markers that point into the turn's source list, and
 * `/n/<id>` links that should open a node in the panel rather than navigate.
 *
 * The old renderer handled the first by bypassing Markdown altogether — any
 * answer with citations was split on blank lines and printed as text, which is
 * why bold, lists and headings came out literal. This module keeps the
 * Markdown intact: a marker becomes a link to a `#cite-n` anchor, and the
 * renderer's `a` component turns that anchor back into a citation chip.
 */

const CITE_PREFIX = "#cite-";

/**
 * Rewrite bare `[n]` markers (1 ≤ n ≤ count) as `[n](#cite-n)` links so they
 * survive the Markdown parser as anchors. Markers that are already links,
 * reference definitions (`[1]: …`) or index into nothing are left alone;
 * adjacent ones (`[1][2]`) become two chips.
 */
export function linkCitationMarkers(text: string, count: number): string {
  if (!text || count <= 0) return text;
  return text.replace(/\[(\d{1,3})\](?![(:])/g, (match, digits: string) => {
    const n = Number(digits);
    if (n < 1 || n > count) return match;
    return `[${n}](${CITE_PREFIX}${n})`;
  });
}

/** The citation index an `href` produced by `linkCitationMarkers` points at, or null. */
export function parseCiteHref(href: string | undefined): number | null {
  if (!href || !href.startsWith(CITE_PREFIX)) return null;
  const n = Number(href.slice(CITE_PREFIX.length));
  return Number.isInteger(n) && n >= 1 ? n : null;
}
