/**
 * How a workspace is named when it has to travel as one string.
 *
 * A workspace slug is unique inside its organization, not across the
 * product: two companies both get to call a workspace `docs`. So anything
 * that names one — a URL, an MCP argument, a REST path segment — has to
 * carry the organization too.
 *
 * Two spellings, one meaning:
 *   `<org>/<workspace>`  — for humans and for JSON arguments (MCP tools,
 *                          the web's own /w/<org>/<workspace> URLs)
 *   `<org>~<workspace>`  — the same pair inside a single REST path segment,
 *                          because a slash would split it
 *
 * `parseWorkspaceRef` accepts either, so a caller never has to think about
 * which one it is holding. A bare slug is deliberately NOT accepted: it is
 * the ambiguity this module exists to remove, and guessing an organization
 * on the caller's behalf is how someone ends up writing into the wrong one.
 */

export interface WorkspaceRef {
  org: string;
  workspace: string;
}

const SEGMENT = /^[a-z0-9][a-z0-9-]{0,79}$/;

/** `<org>~<workspace>` — one REST path segment. */
export function workspaceRefPath(org: string, workspace: string): string {
  return `${org}~${workspace}`;
}

/** `<org>/<workspace>` — what a person reads and what MCP arguments carry. */
export function workspaceRefName(org: string, workspace: string): string {
  return `${org}/${workspace}`;
}

/**
 * Read either spelling. Returns null for anything that is not a well-formed
 * pair — including a bare slug, which callers must reject with a message
 * that names the organizations the person could have meant.
 */
export function parseWorkspaceRef(raw: string): WorkspaceRef | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return null;
  const sep = value.includes("~") ? "~" : value.includes("/") ? "/" : null;
  if (!sep) return null;
  const parts = value.split(sep);
  if (parts.length !== 2) return null;
  const org = parts[0] ?? "";
  const workspace = parts[1] ?? "";
  if (!SEGMENT.test(org) || !SEGMENT.test(workspace)) return null;
  return { org, workspace };
}

/** True when the value names a workspace without saying whose it is. */
export function isBareSlug(raw: string): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  return SEGMENT.test(value);
}
