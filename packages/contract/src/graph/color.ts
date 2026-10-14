/**
 * OKLCH → hex sRGB conversion for the graph renderers.
 *
 * Sigma's WebGL color parser only understands legacy CSS colors (`#hex`,
 * `rgb()`, `rgba()` — see sigma's `parseColor`); anything else silently
 * degrades to opaque black. The workspace identity palette is authored in
 * OKLCH (src/lib/workspace-gradients.ts), so every color that crosses into a
 * Sigma attribute must be converted at the graph boundary.
 *
 * Pipeline: OKLCH → OKLab → LMS → linear sRGB → gamma-encoded hex, with
 * out-of-gamut channels clamped to [0, 1]. Matrices are the reference ones
 * from the OKLab specification (Björn Ottosson), matching browsers within
 * ±1/255 per channel.
 */

const OKLCH_PATTERN =
  /^oklch\(\s*([0-9.]+%?)\s+([0-9.]+%?)\s+([0-9.]+(?:deg)?)\s*(?:\/\s*([0-9.]+%?)\s*)?\)$/i;

/**
 * Convert a CSS `oklch(L C H [/ A])` color to `#rrggbb` (or `#rrggbbaa` when
 * an alpha < 1 is present). Non-oklch inputs (already-hex overrides, rgb())
 * pass through untouched, so callers can apply it unconditionally.
 */
export function oklchToHex(value: string): string {
  const match = OKLCH_PATTERN.exec(value.trim());
  if (!match) return value;
  // Percentages per CSS Color 4: 100% lightness = 1, 100% chroma = 0.4.
  const lightness = parseComponent(match[1]!, 1);
  const chroma = parseComponent(match[2]!, 0.4);
  const hueRadians = (parseFloat(match[3]!) * Math.PI) / 180;
  const alpha = match[4] !== undefined ? parseComponent(match[4]!, 1) : 1;

  const labA = chroma * Math.cos(hueRadians);
  const labB = chroma * Math.sin(hueRadians);

  // OKLab → non-linear LMS → linear LMS (cube).
  const l = (lightness + 0.3963377774 * labA + 0.2158037573 * labB) ** 3;
  const m = (lightness - 0.1055613458 * labA - 0.0638541728 * labB) ** 3;
  const s = (lightness - 0.0894841775 * labA - 1.2914855480 * labB) ** 3;

  // Linear LMS → linear sRGB.
  const red = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const green = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const blue = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;

  const hex = [red, green, blue]
    .map((channel) => hexByte(encodeGamma(clamp01(channel))))
    .join("");
  return alpha < 1 ? `#${hex}${hexByte(clamp01(alpha))}` : `#${hex}`;
}

function parseComponent(raw: string, percentScale: number): number {
  return raw.endsWith("%") ? (parseFloat(raw) / 100) * percentScale : parseFloat(raw);
}

/** Linear-light sRGB channel → gamma-encoded sRGB channel (both 0..1). */
function encodeGamma(channel: number): number {
  return channel <= 0.0031308
    ? channel * 12.92
    : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function hexByte(unit: number): string {
  return Math.round(unit * 255).toString(16).padStart(2, "0");
}
