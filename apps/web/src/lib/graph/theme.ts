/**
 * Theme bridge for the WebGL graph renderer.
 *
 * Sigma's color parser only understands legacy CSS colors (#hex / rgb()),
 * while the product tokens are HeroUI OKLCH variables that flip with the
 * `.dark` class / `data-theme` attribute on <html>. This module resolves the
 * live token values into renderer-safe hex at mount (and again on every
 * theme flip), so the graph is native in BOTH themes instead of shipping
 * hardcoded dark-only hex.
 */

export interface GraphPalette {
  isDark: boolean;
  /** Primary label ink. */
  ink: string;
  /** Secondary ink — default node labels. */
  ink2: string;
  /** Tertiary ink — edge labels, hover chrome. */
  ink3: string;
  /** Muted ink. */
  inkMute: string;
  /** Hairline. */
  line: string;
  /** Canvas background. */
  paper: string;
  /** Dimmed (non-neighborhood) node fill while a focus is active. */
  dimNode: string;
  /** Dimmed edge stroke while a focus is active. */
  dimEdge: string;
  /** Neutral fill for untagged-community resources. */
  neutralNode: string;
  /** Hover bubble background / halo ring. */
  hoverBg: string;
  hoverRing: string;
  /** HeroUI semantic inks, for the node fills that MEAN something. */
  danger: string;
  warning: string;
  /** The app's emphasis hue — what the graph paints the thing everything else is for. */
  accent: string;
  /**
   * The app's own font stack, for canvas type. next/font exposes Figtree
   * under a generated family name, so the only reliable way to hand it to a
   * canvas is to ask the DOM what the stage resolved to — `ctx.font` cannot
   * resolve a var().
   */
  fontFamily: string;
}

const FALLBACK_FONT = "ui-sans-serif, system-ui, sans-serif";

const FALLBACK_DARK: GraphPalette = {
  isDark: true,
  ink: "#e6e4df",
  ink2: "#cfcdc6",
  ink3: "#9f9d97",
  inkMute: "#77756f",
  line: "#34332f",
  paper: "#141414",
  dimNode: "#3a3a38",
  dimEdge: "#242423",
  neutralNode: "#6d7683",
  hoverBg: "rgba(22, 22, 20, 0.94)",
  hoverRing: "#e4e1da",
  danger: "#e5786c",
  warning: "#e0a955",
  accent: "#7fa8d8",
  fontFamily: FALLBACK_FONT,
};

const FALLBACK_LIGHT: GraphPalette = {
  isDark: false,
  ink: "#1c1c1c",
  ink2: "#3a3a3a",
  ink3: "#6f6f6f",
  inkMute: "#9a9a9a",
  line: "#e2e2e0",
  paper: "#fcfcfc",
  dimNode: "#d9d9d6",
  dimEdge: "#ededeb",
  neutralNode: "#8b94a3",
  hoverBg: "rgba(255, 255, 255, 0.96)",
  hoverRing: "#1c1c1c",
  danger: "#c0392b",
  warning: "#b07d18",
  accent: "#3b6ea5",
  fontFamily: FALLBACK_FONT,
};

function isDarkTheme(): boolean {
  if (typeof document === "undefined") return true;
  const root = document.documentElement;
  return root.classList.contains("dark") || root.dataset.theme === "dark";
}

/**
 * Resolve one CSS color expression (usually `var(--token)`) to a legacy
 * color string. A probe element lets the browser do the whole cascade —
 * color-mix(), oklch(), nesting — and `getComputedStyle().color` hands back
 * a resolved rgb()/rgba() serialization Sigma can parse.
 */
function resolveCssColor(host: HTMLElement, expression: string): string | null {
  const probe = document.createElement("span");
  probe.style.display = "none";
  probe.style.color = expression;
  host.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  if (!resolved) return null;
  // Guard: if the browser hands back a non-legacy serialization (lab/oklch),
  // Sigma would silently render black — fall back to the static palette.
  return /^(rgb|rgba|#)/i.test(resolved.trim()) ? resolved.trim() : null;
}

/** Parse `#rgb(a)` / `rgb()` / `rgba()` into channels; null when unparseable. */
function parseLegacyColor(value: string): { r: number; g: number; b: number; a: number } | null {
  const trimmed = value.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(trimmed)?.[1];
  if (hex) {
    if (hex.length === 3 || hex.length === 4) {
      const [r, g, b, a] = hex.split("").map((c) => parseInt(c + c, 16));
      return { r: r!, g: g!, b: b!, a: a === undefined ? 1 : a / 255 };
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      return { r, g, b, a };
    }
    return null;
  }
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/i.exec(trimmed);
  if (!rgb) return null;
  const alphaRaw = rgb[4];
  const a = alphaRaw === undefined ? 1 : alphaRaw.endsWith("%") ? parseFloat(alphaRaw) / 100 : parseFloat(alphaRaw);
  return { r: parseFloat(rgb[1]!), g: parseFloat(rgb[2]!), b: parseFloat(rgb[3]!), a };
}

/** Blend `over` onto `base` at `amount` (0 = base, 1 = over). Returns hex. */
export function mixColors(base: string, over: string, amount: number): string {
  const a = parseLegacyColor(base);
  const b = parseLegacyColor(over);
  if (!a || !b) return base;
  const t = Math.max(0, Math.min(1, amount));
  const channel = (x: number, y: number) => Math.round(x + (y - x) * t);
  const byte = (value: number) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
  return `#${byte(channel(a.r, b.r))}${byte(channel(a.g, b.g))}${byte(channel(a.b, b.b))}`;
}

/** Read the live theme palette off the DOM. Safe to call repeatedly. */
export function readGraphPalette(host: HTMLElement | null): GraphPalette {
  const dark = isDarkTheme();
  const fallback = dark ? FALLBACK_DARK : FALLBACK_LIGHT;
  if (!host || typeof getComputedStyle !== "function") return fallback;
  try {
    const ink = resolveCssColor(host, "var(--ink)") ?? fallback.ink;
    const ink2 = resolveCssColor(host, "var(--ink-2)") ?? fallback.ink2;
    const ink3 = resolveCssColor(host, "var(--ink-3)") ?? fallback.ink3;
    const inkMute = resolveCssColor(host, "var(--ink-mute)") ?? fallback.inkMute;
    const line = resolveCssColor(host, "var(--line)") ?? fallback.line;
    // Must be the colour the stage is actually painted in: every dim, hover
    // and depth blend is computed against it, so reading a different token
    // here than the canvas uses makes those blends land on the wrong tone.
    const paper = resolveCssColor(host, "var(--paper)")
      ?? resolveCssColor(host, "var(--paper-2)")
      ?? fallback.paper;
    return {
      isDark: dark,
      ink,
      ink2,
      ink3,
      inkMute,
      line,
      paper,
      dimNode: mixColors(paper, ink, dark ? 0.16 : 0.14),
      dimEdge: mixColors(paper, ink, dark ? 0.07 : 0.06),
      neutralNode: mixColors(paper, ink, dark ? 0.42 : 0.45),
      hoverBg: dark ? "rgba(22, 22, 20, 0.94)" : "rgba(255, 255, 255, 0.96)",
      hoverRing: ink,
      danger: resolveCssColor(host, "var(--danger)") ?? fallback.danger,
      warning: resolveCssColor(host, "var(--warning)") ?? fallback.warning,
      accent: resolveCssColor(host, "var(--accent)") ?? fallback.accent,
      fontFamily: getComputedStyle(host).fontFamily.trim() || fallback.fontFamily,
    };
  } catch {
    return fallback;
  }
}

/**
 * Invoke `onChange` whenever the app theme flips. The theme script toggles
 * both the `dark` class and `data-theme` on <html>, so one attribute
 * observer covers manual switching and system-theme following.
 */
export function watchGraphTheme(onChange: () => void): () => void {
  if (typeof MutationObserver === "undefined" || typeof document === "undefined") return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
  return () => observer.disconnect();
}

/** Relative luminance (WCAG) of a legacy color string; null when unparseable. */
function relativeLuminance(value: string): number | null {
  const parsed = parseLegacyColor(value);
  if (!parsed) return null;
  const channel = (raw: number) => {
    const unit = raw / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(parsed.r) + 0.7152 * channel(parsed.g) + 0.0722 * channel(parsed.b);
}

/**
 * The ink that reads on top of `fill` — the theme's foreground or its paper,
 * whichever contrasts more.
 *
 * Node fills span the whole range on one canvas: content is a barely-tinted
 * paper, a tag hub is a saturated hue, a credential is full danger red and the
 * workspace hub carries its own gradient. A glyph drawn in one fixed ink would
 * vanish on some of them, in one theme or the other.
 */
export function readableInkOn(fill: string, palette: GraphPalette): string {
  const fillLuminance = relativeLuminance(fill);
  if (fillLuminance === null) return palette.ink;
  const contrast = (against: string) => {
    const other = relativeLuminance(against);
    if (other === null) return 0;
    const [lighter, darker] = fillLuminance > other ? [fillLuminance, other] : [other, fillLuminance];
    return (lighter + 0.05) / (darker + 0.05);
  };
  return contrast(palette.ink) >= contrast(palette.paper) ? palette.ink : palette.paper;
}
