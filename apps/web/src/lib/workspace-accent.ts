/**
 * Workspace accent derivation — turns the gradient a user picked at
 * workspace-creation time into a usable UI accent (solid color + readable
 * foreground) for each theme.
 *
 * Formula (documented for the PR/report):
 *   1. Start from the gradient's PRIMARY stop (`from`), parsed as OKLCH.
 *   2. Clamp chroma to ≤ 0.17 so no preset screams louder than the rest,
 *      then gamut-map (reduce chroma) until the color is inside sRGB.
 *   3. Per theme, seed lightness inside a band that keeps the accent
 *      recognisable next to its gradient tile:
 *        · light theme: L ∈ [0.44, 0.58]
 *        · dark theme:  L ∈ [0.52, 0.66]  (floor 0.52 keeps ≥ ~3:1 against
 *          HeroUI's dark background oklch(12%…) for non-text UI contrast)
 *   4. Pick the foreground (snow vs. eclipse — HeroUI's own primitives) with
 *      the higher WCAG contrast, then walk L in 0.005 steps AWAY from that
 *      foreground until contrast(fg, accent) ≥ 4.5 (WCAG AA, normal text).
 *      If the theme band's edge is hit before reaching 4.5, the foreground
 *      flips and L walks the other way — so the pair is always AA.
 *   5. Contrast is computed in real sRGB (OKLCH → linear sRGB → WCAG
 *      relative luminance), not eyeballed from OKLCH lightness.
 *
 * Everything here is pure and deterministic so it can be unit-tested and
 * reused server-side if needed.
 */

import type { WorkspaceGradient } from "@bcontext-dev/contract/workspace-gradients";

interface Oklch {
  /** Lightness 0–1 */
  l: number;
  /** Chroma ≥ 0 */
  c: number;
  /** Hue in degrees */
  h: number;
}

interface ThemeAccent {
  /** CSS color for the solid accent (oklch(), sRGB-gamut-safe). */
  accent: string;
  /** CSS color for text/icons rendered on top of the accent. */
  foreground: string;
  /** WCAG contrast ratio between the two (for tests/debugging). */
  contrast: number;
}

interface WorkspaceAccent {
  light: ThemeAccent;
  dark: ThemeAccent;
}

/* HeroUI primitives (see @heroui/react default theme): --snow / --eclipse. */
const SNOW: Oklch = { l: 0.9911, c: 0, h: 0 };
const ECLIPSE: Oklch = { l: 0.2103, c: 0.0059, h: 285.89 };
const SNOW_CSS = "oklch(99.11% 0 0)";
const ECLIPSE_CSS = "oklch(21.03% 0.0059 285.89)";

const AA_NORMAL = 4.5;
const L_STEP = 0.005;
const MAX_CHROMA = 0.17;

/** Parse `oklch(62% 0.16 145)` / `oklch(0.62 0.16 145)`. Returns null on failure. */
function parseOklch(input: string): Oklch | null {
  const m = /oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)/i.exec(input);
  if (!m) return null;
  const rawL = Number(m[1]);
  const l = m[2] === "%" ? rawL / 100 : rawL;
  const c = Number(m[3]);
  const h = Number(m[4]);
  if (![l, c, h].every(Number.isFinite)) return null;
  return { l, c, h };
}

/* ── OKLCH → sRGB (Björn Ottosson's reference matrices) ────────────────── */

function oklchToLinearSrgb({ l, c, h }: Oklch): [number, number, number] {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);

  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;

  const l3 = l_ ** 3;
  const m3 = m_ ** 3;
  const s3 = s_ ** 3;

  return [
    +4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
}

function inSrgbGamut(rgb: [number, number, number]): boolean {
  const EPS = 1e-4;
  return rgb.every((ch) => ch >= -EPS && ch <= 1 + EPS);
}

/** Reduce chroma until the color fits inside the sRGB gamut. */
function gamutMapChroma(color: Oklch): Oklch {
  let c = Math.max(0, color.c);
  while (c > 0 && !inSrgbGamut(oklchToLinearSrgb({ ...color, c }))) {
    c = Math.max(0, c - 0.004);
  }
  return { ...color, c };
}

/* ── WCAG contrast ──────────────────────────────────────────────────────── */

/** WCAG relative luminance straight from linear sRGB channels. */
function relativeLuminance(color: Oklch): number {
  const [r, g, b] = oklchToLinearSrgb(gamutMapChroma(color)).map((ch) =>
    Math.min(1, Math.max(0, ch)),
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio between two colors. */
function contrastRatio(a: Oklch, b: Oklch): number {
  const ya = relativeLuminance(a);
  const yb = relativeLuminance(b);
  const [hi, lo] = ya >= yb ? [ya, yb] : [yb, ya];
  return (hi + 0.05) / (lo + 0.05);
}

/* ── Fitting ────────────────────────────────────────────────────────────── */

function fmt(color: Oklch): string {
  const l = `${(color.l * 100).toFixed(2).replace(/\.?0+$/, "")}%`;
  const c = Number(color.c.toFixed(4));
  const h = Number(color.h.toFixed(2));
  return `oklch(${l} ${c} ${h})`;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

interface FitBand {
  min: number;
  max: number;
}

/**
 * Walk lightness away from the chosen foreground until the pair passes
 * WCAG AA (4.5:1). If the band edge is reached first, flip the foreground
 * and walk the other way. Always terminates: pushing L towards 0 (snow fg)
 * or 1 (eclipse fg) monotonically raises contrast past 4.5.
 */
function fit(seed: Oklch, band: FitBand): ThemeAccent {
  const color = gamutMapChroma({ ...seed, l: clamp(seed.l, band.min, band.max) });

  const prefersSnow = contrastRatio(SNOW, color) >= contrastRatio(ECLIPSE, color);
  let attempt = fitWithForeground(color, prefersSnow ? SNOW : ECLIPSE, band, true);
  if (attempt.contrast < AA_NORMAL) {
    // Band edge blocked us — flip the foreground and let it leave the band.
    attempt = fitWithForeground(color, prefersSnow ? ECLIPSE : SNOW, band, false);
  }
  return attempt;
}

function fitWithForeground(
  start: Oklch,
  fg: Oklch,
  band: FitBand,
  respectBand: boolean,
): ThemeAccent {
  const darken = fg === SNOW; // light text → accent must get darker
  const floor = respectBand ? band.min : 0.05;
  const ceil = respectBand ? band.max : 0.98;

  let color = start;
  for (let i = 0; i < 400; i++) {
    if (contrastRatio(fg, color) >= AA_NORMAL) break;
    const next = clamp(color.l + (darken ? -L_STEP : L_STEP), floor, ceil);
    if (next === color.l) break; // hit the edge — caller decides what's next
    color = gamutMapChroma({ ...color, l: next });
  }

  return {
    accent: fmt(color),
    foreground: fg === SNOW ? SNOW_CSS : ECLIPSE_CSS,
    contrast: contrastRatio(fg, color),
  };
}

/* ── Public API ─────────────────────────────────────────────────────────── */

const LIGHT_BAND: FitBand = { min: 0.44, max: 0.58 };
const DARK_BAND: FitBand = { min: 0.52, max: 0.66 };

/**
 * Derive the per-theme accent pair for a workspace gradient.
 * Deterministic: same gradient in → same CSS colors out.
 */
function deriveWorkspaceAccent(gradient: WorkspaceGradient): WorkspaceAccent {
  const stop =
    parseOklch(gradient.from) ?? { l: 0.62, c: 0.15, h: gradient.hue };
  const seed: Oklch = { ...stop, c: Math.min(stop.c, MAX_CHROMA) };

  return {
    light: fit(seed, LIGHT_BAND),
    dark: fit(seed, DARK_BAND),
  };
}

/**
 * HeroUI's default accent (the product blue). `--info`/`--info-2` stay pinned
 * to it so informational chips/highlights never follow the workspace tint.
 */
const PRODUCT_INFO = "oklch(62.04% 0.195 253.83)";

/**
 * CSS emitted SERVER-SIDE by the workspace layout (`app/w/[org]/[ws]/layout.tsx`)
 * as an inline `<style>` so the accent ships in the first HTML chunk — the
 * accent must be live BEFORE first paint or buttons flash HeroUI blue for a
 * frame (FOUC reported against PR #120).
 *
 * Why remapping `--accent` on `:root` is sufficient: HeroUI declares every
 * derived token (--accent-hover/-soft/-soft-hover, --focus, --chart-*) on
 * the same `<html>` element as color-mix()/var() expressions over --accent
 * inside `@layer theme`; an unlayered `:root` override wins the cascade and
 * the derived declarations re-resolve with it — portaled overlays included.
 *
 * Dark mode needs no runtime knowledge here: both rules are emitted and the
 * blocking theme script (theme-script.tsx) stamps `.dark`/[data-theme] on
 * <html> before paint, so the right rule already matches at first paint.
 *
 * Lifecycle is React-managed: the <style> node updates in-commit on client
 * navigation between workspaces (accent switch is immediate, no blue
 * intermediate) and unmounts with the layout (hub/login/consent revert to
 * the neutral product accent).
 */
export function workspaceAccentCss(gradient: WorkspaceGradient): string {
  const { light, dark } = deriveWorkspaceAccent(gradient);
  return (
    `:root{--accent:${light.accent};--accent-foreground:${light.foreground};` +
    `--info:${PRODUCT_INFO};--info-2:color-mix(in oklab, ${PRODUCT_INFO} 15%, transparent);}\n` +
    `:root.dark,:root[data-theme="dark"]{--accent:${dark.accent};--accent-foreground:${dark.foreground};}`
  );
}
