import { oklchToHex } from "@bcontext-dev/contract/graph/color";

/**
 * Tag identity color — one source of truth for the graph canvas AND for
 * every tag chip outside it.
 *
 * A tag's color is derived from its own immutable uuid. The graph used to
 * hand colors out by RANK (palette slot in community-size order), so a tag
 * changed color whenever nodes were assigned to it or to a sibling; once the
 * color is identity — the same hue labels the tag in a list, in the picker
 * and on the canvas — it has to be exactly as stable as the id it belongs to.
 *
 * The hash picks the HUE and nothing else. Lightness and chroma are fixed by
 * the theme, inside the band HeroUI's own chart ramp occupies, so every tag
 * color carries the same visual weight as the workspace accent and the set
 * reads as one designed palette rather than a rainbow.
 *
 * WHY THE HUE IS QUANTIZED, AND WHY NOTHING RESOLVES COLLISIONS
 * A pure function of the id is the only thing a tag chip can compute: it
 * knows its own tag and nothing else — no snapshot, no sibling list. An
 * earlier version claimed hues with forward probing so that no two tags on
 * one canvas could match, which works beautifully on the canvas and cannot
 * be reproduced anywhere else, so the chip and the graph would have
 * disagreed — and not rarely: with 24 buckets a workspace of 16 tags
 * collides essentially always (birthday, not bad luck). Agreement across
 * surfaces is the entire point of moving color onto the tag, so it wins.
 *
 * Hence the trade: two tags CAN share a hue. Quantizing to 24 buckets is
 * what makes that acceptable — colors that differ are always a clear 15°
 * apart, and colors that collide collide exactly, reading as a repeat rather
 * than as two nearly-identical hues the eye keeps trying to separate. Nested
 * tags additionally split by depth below. A guaranteed-unique color per tag
 * needs a hue that is stored rather than derived — a persisted slot on the
 * tag itself, chosen once.
 */
export const TAG_HUE_BUCKETS = 24;
const HUE_STEP = 360 / TAG_HUE_BUCKETS;

/** Root lightness/chroma per theme. Nested tags lift off these. */
const TAG_LIGHTNESS = { light: 0.52, dark: 0.76 } as const;
const TAG_CHROMA = { light: 0.15, dark: 0.13 } as const;
/** Each nesting level lifts L and drops C: one hue family, distinct members. */
const DEPTH_LIGHTNESS_STEP = 0.05;
const DEPTH_CHROMA_STEP = 0.02;
const MAX_DEPTH_TIER = 3;

/** FNV-1a: stable, dependency-free, well spread over uuid strings. */
function hashCode(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * The graph addresses a tag as the resource id `tag:<uuid>` while a chip has
 * the bare uuid. Both must hash to the same hue, so the prefix comes off
 * first.
 */
export function tagIdentity(tagIdOrResourceId: string): string {
  return tagIdOrResourceId.startsWith("tag:") ? tagIdOrResourceId.slice(4) : tagIdOrResourceId;
}

/** The hue bucket a tag's id hashes to (0..TAG_HUE_BUCKETS-1); collisions are accepted. */
export function tagHueBucket(tagIdOrResourceId: string): number {
  return hashCode(tagIdentity(tagIdOrResourceId)) % TAG_HUE_BUCKETS;
}

/** A tag's hue in degrees, resolved from its id alone. */
export function tagHueDegrees(tagIdOrResourceId: string): number {
  return tagHueBucket(tagIdOrResourceId) * HUE_STEP;
}

/**
 * Tag color as hex, for the WebGL canvas: Sigma's color parser only reads
 * legacy CSS colors, and an oklch() string silently renders as opaque black.
 * `depth` is the tag's nesting level — it only lifts the color toward the
 * paper, so a branch stays one hue family while its members separate.
 */
export function tagNodeColor(hue: number, isDark: boolean, depth = 1): string {
  const tier = Math.max(0, Math.min(MAX_DEPTH_TIER, Math.round(depth) - 1));
  const lightness = (isDark ? TAG_LIGHTNESS.dark : TAG_LIGHTNESS.light) + tier * DEPTH_LIGHTNESS_STEP;
  const chroma = Math.max(0.04, (isDark ? TAG_CHROMA.dark : TAG_CHROMA.light) - tier * DEPTH_CHROMA_STEP);
  return oklchToHex(`oklch(${lightness.toFixed(3)} ${chroma.toFixed(3)} ${hue.toFixed(1)})`);
}

/**
 * Tag color for the DOM, as a CSS expression. Unlike the canvas variant this
 * one does NOT bake the theme in: `--tag-l` / `--tag-c` are declared per
 * theme in globals.css, so one string is correct in light, in dark, and
 * inside a scoped theme island.
 */
export function tagColorCss(tagIdOrResourceId: string): string {
  return `oklch(var(--tag-l) var(--tag-c) ${tagHueDegrees(tagIdOrResourceId).toFixed(1)})`;
}
