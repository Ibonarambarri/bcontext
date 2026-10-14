/**
 * A permission operation that nothing calls is not a feature.
 *
 * This is the third time in this phase the same shape has appeared. The grant
 * mirror shipped with zero callers, so revocation silently did not revoke. The
 * invitation module shipped complete, reviewed and merged, with no tool exposing
 * it — the admin-over-MCP feature it was written for did not exist, and nothing
 * failed, because unreachable code passes every test written about it.
 *
 * `grants.ts` and `admin.ts` are safe from this by accident: their functions are
 * called on every request. `invitations.ts` was not, and the next module like it
 * will not be either. So the rule is written down instead of remembered: an
 * exported function in the permission model whose first parameter is a `Grant`
 * is an operation someone is meant to perform, and it has to be reachable from
 * the MCP surface or an API route.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(process.cwd(), "src");
const AUTH_DIR = join(SRC, "lib/auth");

/** Files whose exports are the model itself rather than operations on it. */
const NOT_OPERATIONS = new Set(["grants.ts", "scoped.ts", "require.ts", "workspace.ts"]);

/**
 * `export async function name(\n  first: Grant,` — an operation performed *by* a
 * principal, as opposed to a helper that merely mentions the type.
 */
function grantTakingExports(source: string): string[] {
  const pattern =
    /export\s+(?:async\s+)?function\s+(\w+)\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)?\w+\s*:\s*Grant\b/g;
  return [...source.matchAll(pattern)].map((m) => m[1]!);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

describe("permission operations are reachable", () => {
  const callerSources = walk(SRC)
    .filter((f) => !f.startsWith(AUTH_DIR))
    .map((f) => readFileSync(f, "utf8"));

  const operations: Array<{ file: string; name: string }> = [];
  for (const entry of readdirSync(AUTH_DIR)) {
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    if (NOT_OPERATIONS.has(entry)) continue;
    for (const name of grantTakingExports(readFileSync(join(AUTH_DIR, entry), "utf8"))) {
      operations.push({ file: `lib/auth/${entry}`, name });
    }
  }

  it("finds the operations at all", () => {
    // Guard the guard: if the regex stops matching — a signature is reformatted,
    // the folder moves — this suite would pass by finding nothing to check.
    expect(operations.map((o) => o.name)).toContain("inviteToWorkspace");
    expect(operations.map((o) => o.name)).toContain("grantAccess");
  });

  it("every one of them has a caller outside the permission model", () => {
    const orphans = operations.filter(
      (op) => !callerSources.some((source) => source.includes(op.name)),
    );
    expect(
      orphans,
      orphans.length === 0
        ? ""
        : `These are exported permission operations that nothing outside lib/auth ` +
          `calls, so no agent and no person can perform them:\n` +
          orphans.map((o) => `  ${o.file} — ${o.name}()`).join("\n") +
          `\n\nWire them into src/lib/mcp/server.ts or an API route.`,
    ).toEqual([]);
  });
});
