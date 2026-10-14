/**
 * Every write to `memberships` or `agent_workspace_access` must reach the grant
 * table too.
 *
 * `resolveGrant` used to intersect a grant row with those two tables, which made
 * a stale grant harmless — the legacy answer clamped it. Removing the
 * intersection made grants authoritative and moved that safety from read time to
 * write time: access now changes only where someone writes it.
 *
 * The first cut of that change shipped `syncGrantFromAgentAccess` with **zero
 * callers**. Disconnecting an agent from one workspace revoked its row and left
 * its grant live, so it kept reading and writing there — a revocation bypass, in
 * the exact function written to prevent it. Four paths were missing in total, and
 * the whole suite passed, because a mirror that nobody calls breaks nothing that
 * is tested directly.
 *
 * So this guard does not test the mirroring. It tests that the mirror is *wired*,
 * by reading the source: a file that writes either table and never mentions
 * `grant-sync` is the shape of that bug, whether or not anyone remembers this
 * paragraph. Legitimate exceptions name themselves below with a reason.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(process.cwd(), "src");

const ACCESS_TABLES = ["memberships", "agent_workspace_access"] as const;
const WRITE_METHODS = ["insert", "upsert", "update", "delete"] as const;

/**
 * Files that write an access table without mirroring, and may.
 *
 * Short on purpose — this list is the audit surface. Every entry is a place
 * where access changes and the grant table does not, so each one has to be
 * arguable on its own.
 */
const EXEMPT: Record<string, string> = {
  "lib/auth/invitations.ts":
    "writes the grant row itself, with the invitation's verbs and reach — a role-derived mirror would overwrite the narrowing that is the point of the invitation",
  "lib/agents/connections.server.ts":
    "revokeAgentEverywhere updates workspace_grants directly, across every workspace at once, rather than one mirror call per row",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

/** `.from("memberships")` followed, within a few chained calls, by a write. */
function writesAccessTable(source: string): string | null {
  for (const table of ACCESS_TABLES) {
    const pattern = new RegExp(
      `\\.from\\(\\s*["'\`]${table}["'\`]\\s*\\)[\\s\\S]{0,200}?\\.(${WRITE_METHODS.join("|")})\\(`,
      "g",
    );
    for (const match of source.matchAll(pattern)) {
      // A `.select(...).delete()`-shaped false positive would have to span a
      // statement boundary; require the match to stay inside one chain.
      if (!/;/.test(match[0])) return `${table}.${match[1]}`;
    }
  }
  return null;
}

describe("writes to access tables mirror into grants", () => {
  const offenders: Array<{ file: string; write: string }> = [];

  for (const file of walk(SRC)) {
    const rel = relative(SRC, file);
    if (rel in EXEMPT) continue;
    const source = readFileSync(file, "utf8");
    const write = writesAccessTable(source);
    if (!write) continue;
    if (source.includes("grant-sync")) continue;
    offenders.push({ file: rel, write });
  }

  it("has no unmirrored write path", () => {
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `These files change access without touching the grant table, which is ` +
          `authoritative:\n` +
          offenders.map((o) => `  ${o.file} — ${o.write}`).join("\n") +
          `\n\nCall syncGrantFromMembership / syncGrantFromAgentAccess beside the ` +
          `write, or add the file to EXEMPT with a reason.`,
    ).toEqual([]);
  });

  it("keeps the exemption list honest", () => {
    // An exemption for a file that no longer writes an access table is stale,
    // and a stale exemption is how the next real one gets waved through.
    for (const [rel, reason] of Object.entries(EXEMPT)) {
      const source = readFileSync(join(SRC, rel), "utf8");
      expect(writesAccessTable(source), `${rel} no longer writes an access table`).not.toBeNull();
      expect(reason.length, `${rel} needs a real reason`).toBeGreaterThan(20);
    }
  });
});
