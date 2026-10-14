import type { GraphResourcePayload } from "@bcontext-dev/contract/graph/model";
import { KIND_GLYPH_BODIES, type GlyphKey } from "./kind-glyphs.generated";

/**
 * Node-kind glyphs for the WebGL canvas.
 *
 * Everywhere else in the app a kind is a lucide glyph (`node-kind-icon.ts`);
 * a hue per kind on the graph would be a vocabulary that exists nowhere else
 * in the product. So the canvas draws the SAME icon, and a decision looks
 * like a decision whether you are reading a list or the map.
 *
 * lucide-react closes over its path data, so the markup is generated from the
 * installed package into `kind-glyphs.generated.ts` — see
 * scripts/generate-kind-glyphs.mjs for why it is derived rather than copied.
 */

/** lucide's own root attributes, minus the color, which the caller supplies. */
const SVG_ROOT =
  'xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"'
  + ' fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

/**
 * The texture atlas keys on the image URL, so the same glyph/color pair must
 * always produce the identical string — hence the memo rather than rebuilding
 * a data URI per frame.
 */
const uriCache = new Map<string, string>();

/** The SVG data URI sigma loads as the node's image, stroked in `color`. */
export function kindGlyphDataUri(key: GlyphKey, color: string): string {
  const cacheKey = `${key}|${color}`;
  const cached = uriCache.get(cacheKey);
  if (cached) return cached;
  // `color` covers the few glyphs that paint a detail with currentColor
  // (the credential key's pin, for one); `stroke` covers everything else.
  const svg = `<svg ${SVG_ROOT} stroke="${color}" color="${color}">${KIND_GLYPH_BODIES[key]}</svg>`;
  const uri = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  uriCache.set(cacheKey, uri);
  return uri;
}

/**
 * The glyph a resource carries, or null for the ones that are landmarks
 * rather than content: the workspace hub (it has its own gradient and is
 * already the biggest thing on the canvas) and cluster aggregates.
 */
export function glyphKeyForResource(resource: GraphResourcePayload, hubNodeId: string | null | undefined): GlyphKey | null {
  if (resource.id === hubNodeId) return null;
  if (resource.resource_type === "tag") return "tag";
  if (resource.resource_type === "node") return resource.kind;
  return null;
}
