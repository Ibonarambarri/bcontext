/**
 * Slugs, and why they are generated rather than typed.
 *
 * A slug is an address: it ends up in URLs people bookmark, in MCP
 * arguments agents have written down, and in the invitation links that are
 * already in someone's inbox. So it is derived from the name once, at
 * creation, disambiguated with a number when it collides, and then frozen —
 * renaming a workspace changes what it is called, not where it lives.
 *
 * Two scopes, because that is what the schema enforces: organization slugs
 * are unique across the product, workspace slugs only inside their
 * organization (`unique (organization_id, slug)`, migration 0001).
 */
import { slugify } from "@bcontext-dev/contract/utils";

/** What a name becomes before uniqueness is considered. */
export function baseSlug(name: string, fallback: string): string {
  const slug = slugify(name).replace(/^-+|-+$/g, "").slice(0, 60);
  return slug || fallback;
}

/**
 * `base`, or `base-2`, `base-3`… — the first spelling `taken` does not hold.
 *
 * The numeric suffix is the whole disambiguation strategy: it is what a
 * person expects (they named two things the same), it is readable, and
 * unlike a random suffix it stays stable for the first of anything.
 */
export function disambiguate(base: string, taken: Iterable<string>): string {
  const used = new Set<string>();
  for (const t of taken) used.add(t.toLowerCase());
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  // A thousand workspaces called the same thing is not a naming collision,
  // it is a bug upstream — fall back to something that cannot collide.
  return `${base}-${Date.now().toString(36)}`;
}
