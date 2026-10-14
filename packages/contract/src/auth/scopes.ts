/**
 * Bearer-token scopes for the agent API + MCP server.
 *
 * Naming convention: `resource:action`. `admin:*` is a wildcard that
 * grants every scope; do not invent other wildcards.
 *
 * Keep this list short — every new scope is forever.
 */
export const SCOPES = [
  "nodes:read",
  "nodes:write",
  "chat:run",
  "skills:execute",
  "agents:read",
  "agents:write",
  "credentials:use",
  "admin:*",
] as const;

export type Scope = (typeof SCOPES)[number];

const SCOPE_SET = new Set<string>(SCOPES);

export function isScope(value: unknown): value is Scope {
  return typeof value === "string" && SCOPE_SET.has(value);
}

/**
 * Scopes the `admin:*` wildcard does NOT grant. A wildcard is a statement
 * about breadth of authority; handing an agent the plaintext of a secret is
 * a different kind of decision, and it should be visible in the token's own
 * scope list rather than inherited from a blanket `admin:*`. So
 * `credentials:use` is opt-in, per token, always.
 */
const EXPLICIT_ONLY = new Set<Scope>(["credentials:use"]);

/**
 * Returns true if the token's `held` scopes satisfy `required`. The
 * `admin:*` wildcard satisfies any required scope except the explicit-only
 * ones above, which must be listed by name.
 */
export function hasScope(held: readonly string[], required: Scope): boolean {
  if (EXPLICIT_ONLY.has(required)) return held.includes(required);
  if (held.includes("admin:*")) return true;
  return held.includes(required);
}

export function parseScopes(input: unknown): Scope[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<Scope>();
  for (const v of input) if (isScope(v)) seen.add(v);
  return Array.from(seen);
}
