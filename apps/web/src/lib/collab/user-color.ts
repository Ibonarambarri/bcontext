/**
 * Deterministic cursor colour for a user id. Pulls from a curated palette of
 * 16 high-contrast hues — same input always lands on the same hue so a peer's
 * cursor stays stable across reconnects.
 */
const PALETTE = [
  "#f97316", // orange-500
  "#ef4444", // red-500
  "#ec4899", // pink-500
  "#a855f7", // purple-500
  "#6366f1", // indigo-500
  "#3b82f6", // blue-500
  "#06b6d4", // cyan-500
  "#14b8a6", // teal-500
  "#10b981", // emerald-500
  "#84cc16", // lime-500
  "#eab308", // yellow-500
  "#f59e0b", // amber-500
  "#d946ef", // fuchsia-500
  "#0ea5e9", // sky-500
  "#22c55e", // green-500
  "#8b5cf6", // violet-500
];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** The same id always maps to the same palette entry (FNV-1a over the id). */
export function userColor(id: string): string {
  return PALETTE[hash(id) % PALETTE.length] ?? "#888888";
}

/**
 * Friendly display name from an email or user-id. Strips the domain and
 * everything after a `+` alias, capitalises the local part. Falls back to
 * the trimmed input when it's already short.
 */
export function displayName(input: string | null | undefined): string {
  if (!input) return "Guest";
  const trimmed = input.trim();
  if (!trimmed) return "Guest";
  const at = trimmed.indexOf("@");
  const local = at > 0 ? trimmed.slice(0, at) : trimmed;
  const base = local.split("+")[0]!.replace(/[._-]+/g, " ").trim();
  if (!base) return "Guest";
  return base
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
