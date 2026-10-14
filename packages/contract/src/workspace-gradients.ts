/**
 * Gradient palette for workspace identities. Six presets cover a wide hue
 * spread while staying inside a consistent perceptual band (OKLCH chroma
 * ≈ 0.13–0.17, lightness ≈ 55%–70%) so glyphs read the same regardless of
 * which preset a user picks.
 *
 * Storage convention: `workspaces.metadata.accent_gradient` holds the id of
 * a preset (e.g. `"forest"`). Old workspaces still carrying `accent_hue`
 * (legacy number 0–360) are mapped to the nearest preset via `hueToId()`.
 * Workspaces with no preference at all fall back to a deterministic hash of
 * the slug so identity stays stable.
 */

export interface WorkspaceGradient {
  id: string;
  name: string;
  /** Used as the OKLCH center hue for derived accents (rings, dots). */
  hue: number;
  from: string;
  to: string;
}

export const GRADIENTS: WorkspaceGradient[] = [
  {
    id: "forest",
    name: "Forest",
    hue: 145,
    from: "oklch(62% 0.16 145)",
    to: "oklch(70% 0.14 80)",
  },
  {
    id: "ocean",
    name: "Ocean",
    hue: 230,
    from: "oklch(58% 0.15 250)",
    to: "oklch(70% 0.14 200)",
  },
  {
    id: "ember",
    name: "Ember",
    hue: 30,
    from: "oklch(66% 0.18 30)",
    to: "oklch(70% 0.15 60)",
  },
  {
    id: "orchid",
    name: "Orchid",
    hue: 320,
    from: "oklch(64% 0.16 320)",
    to: "oklch(66% 0.16 280)",
  },
  {
    id: "rose",
    name: "Rose",
    hue: 10,
    from: "oklch(62% 0.18 10)",
    to: "oklch(70% 0.13 340)",
  },
  {
    id: "slate",
    name: "Slate",
    hue: 240,
    from: "oklch(55% 0.06 240)",
    to: "oklch(70% 0.05 200)",
  },
];

export const DEFAULT_GRADIENT_ID = "forest";

export function gradientById(id: string | null | undefined): WorkspaceGradient {
  if (!id) return GRADIENTS[0]!;
  return GRADIENTS.find((g) => g.id === id) ?? GRADIENTS[0]!;
}

function hash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Pick a stable gradient for a workspace when no explicit preference is
 * stored. Same slug always lands on the same gradient so identity is
 * recognisable across sessions.
 */
export function defaultGradientForSlug(slug: string): WorkspaceGradient {
  return GRADIENTS[hash(slug) % GRADIENTS.length]!;
}

/**
 * Legacy mapping: pre-gradient workspaces stored a hue in `accent_hue`.
 * Translate the hue to the nearest preset by angular distance on the OKLCH
 * hue wheel.
 */
function hueToGradient(hue: number): WorkspaceGradient {
  let best = GRADIENTS[0]!;
  let bestD = 360;
  for (const g of GRADIENTS) {
    const d = Math.min(
      Math.abs(g.hue - hue),
      360 - Math.abs(g.hue - hue),
    );
    if (d < bestD) {
      bestD = d;
      best = g;
    }
  }
  return best;
}

/**
 * Gradient the user (or a legacy migration) EXPLICITLY stored for a
 * workspace, or `null` when nothing is saved. Used by the per-workspace
 * accent theme: only an explicit choice re-tints the app's action buttons —
 * hash-fallback identities keep the neutral product accent.
 */
export function explicitGradientFor(
  metadata?: Record<string, unknown> | null,
): WorkspaceGradient | null {
  const raw = metadata?.accent_gradient;
  if (typeof raw === "string") {
    const hit = GRADIENTS.find((g) => g.id === raw);
    if (hit) return hit;
  }
  const hue = metadata?.accent_hue;
  if (typeof hue === "number" && Number.isFinite(hue)) {
    return hueToGradient(hue);
  }
  return null;
}

/**
 * Resolve the gradient to render for a workspace. Preference order:
 *   1. `metadata.accent_gradient` — id of a preset (new model).
 *   2. `metadata.accent_hue`      — legacy number, mapped to nearest preset.
 *   3. Hash of the slug           — deterministic fallback.
 */
export function gradientFor({
  slug,
  metadata,
}: {
  slug: string;
  metadata?: Record<string, unknown> | null;
}): WorkspaceGradient {
  return explicitGradientFor(metadata) ?? defaultGradientForSlug(slug);
}

/** CSS shorthand for the gradient at a 135° angle. */
export function gradientCss(g: WorkspaceGradient): string {
  return `linear-gradient(135deg, ${g.from}, ${g.to})`;
}
