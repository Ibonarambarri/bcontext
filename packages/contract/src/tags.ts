/** Shared tag normalization rules. Keep in sync with normalize_tag_name SQL. */
export function normalizeTagName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}
export function normalizeTagNames(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = normalizeTagName(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function tagSlugBase(value: string): string {
  return (
    normalizeTagName(value)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "tag"
  );
}

export const DEFAULT_WORKSPACE_TAGS = [
  "business",
  "product",
  "tech",
  "ai",
] as const;
