/**
 * Guard against caller-supplied node ids read without proving tenancy.
 *
 * Two routes shipped this bug (found by audit, 2026-09-01): `/api/embed` and
 * `/api/meetings/[nodeId]/recording-status` both took a `nodeId` straight from
 * the caller, looked it up with the service-role client — which bypasses RLS —
 * and never checked that the caller could touch the workspace that row belongs
 * to. A `nodes:write` scope in ANY workspace was enough to rewrite another
 * tenant's embeddings.
 *
 * The class of bug matters more than the two instances, so this test scans the
 * route tree instead of exercising the handlers: any route that looks a node up
 * by a caller-supplied id must either constrain the query by workspace or prove
 * membership. Fixing one route while a new one reintroduces the pattern next
 * month would be no fix at all.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const API_DIR = join(process.cwd(), "src/app/api");

/**
 * Routes that read nodes by id without a tenancy check, each for a reason that
 * has been looked at. Keep this list short and justified — an entry here is a
 * claim that the route cannot leak across tenants.
 */
const REVIEWED: Record<string, string> = {
  // Signed by the provider's HMAC; the bot row itself carries the workspace.
  "connectors/meeting-bot/webhook/route.ts": "system, HMAC-authenticated",
  // Creates the workspace; there is no membership to check yet.
  "onboarding/create/route.ts": "creates the workspace it writes to",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

describe("routes reading nodes by caller-supplied id", () => {
  it("constrain by workspace or prove membership", () => {
    const offenders: string[] = [];

    for (const file of walk(API_DIR)) {
      const rel = file.slice(API_DIR.length + 1);
      if (REVIEWED[rel]) continue;

      const src = readFileSync(file, "utf8");

      // Does it look a node up by id at all?
      const readsNodesById =
        /\.from\(\s*["']nodes["']\s*\)/.test(src) && /\.eq\(\s*["']id["']/.test(src);
      if (!readsNodesById) continue;

      // Three ways to be safe, and the third is the subtle one. Looking only for
      // the helper's *name* is not enough: a route can resolve storage from a
      // body-supplied slug, call requireWorkspaceMember on that, and then read
      // an unrelated caller-supplied node id — proving membership somewhere
      // while never tying the node to it. What actually closes the hole is
      // comparing the node's own workspace against the authorised one, which is
      // what makes connectors/meeting-bot/schedule safe.
      const constrained = /\.eq\(\s*["']workspace_id["']/.test(src);
      const comparesNodeWorkspace = /workspace_id\s*!==/.test(src);
      const storageFromNode =
        /getStorageById\(\s*\w+\.workspace_id\s*\)/.test(src) &&
        src.includes("requireWorkspaceMember");

      if (!constrained && !comparesNodeWorkspace && !storageFromNode) {
        offenders.push(rel);
      }
    }

    expect(
      offenders,
      `These routes read a node by caller-supplied id without tying it to a ` +
        `workspace the caller was authorised for. Constrain the query, compare ` +
        `the node's workspace_id against the authorised one, or resolve storage ` +
        `from the node itself — or justify the route in REVIEWED above.\n  ` +
        offenders.join("\n  "),
    ).toEqual([]);
  });
});
