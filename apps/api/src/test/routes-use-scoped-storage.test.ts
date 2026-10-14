/**
 * Every API route must reach node data through a storage narrowed to the
 * caller's grant.
 *
 * The three-line dance that 31 routes repeat today — `gate`, `getStorage`,
 * `requireWorkspaceMember` — proves the caller belongs to the workspace and
 * stops there. It cannot express "and only the finanzas slice of it", and a
 * route that forgets the third line leaks the whole tenant (two did; see
 * `cross-tenant-node-reads.test.ts`).
 *
 * `openWorkspace` does the same three things and hands back a storage that is
 * already scoped, so a route physically cannot read past the grant. This test
 * exists to keep the old pattern from creeping back in: calling `getStorage`
 * directly inside a route is how you opt out of the reach without noticing.
 *
 * Routes that legitimately need an unscoped storage list themselves in
 * `SYSTEM_ROUTES` with a reason. That list is the audit surface — it should be
 * short, and every entry should be arguable.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const API_DIR = join(process.cwd(), "src/app/api");
const LIB_DIR = join(process.cwd(), "src/lib");

/**
 * Library helpers that resolve a storage on behalf of a request.
 *
 * The first version of this guard scanned routes only, and views slipped
 * straight past it: `lib/views/http.ts` did the gate-and-getStorage dance for
 * all five view routes, handed back an unscoped storage, and every one of them
 * looked clean. A guard with the same blind spot as the code it guards is worth
 * very little, so this half looks for the old pattern wherever it lives.
 */
const LIB_HELPERS_EXEMPT: Record<string, string> = {
  "auth/workspace.ts": "this is the door itself",
  "rag.ts": "falls back to an unscoped storage only when no caller supplied one",
  "ingest/candidates.ts": "connector auto-accept builds an explicit systemGrant",
  "mcp/http.ts":
    "the MCP transport, shared by /mcp and /mcp/<org>/<workspace>: resolves the " +
    "workspace itself (the path or the token, never a member check alone) and " +
    "narrows the storage with scopedStorage(inner, grant) before any tool sees it",
};

/**
 * Routes that act as the system rather than on behalf of a principal. Each is
 * authenticated by something other than a user or agent grant, so there is no
 * reach to apply.
 */
const SYSTEM_ROUTES: Record<string, string> = {
  "connectors/meeting-bot/webhook/route.ts": "provider HMAC; no principal",
  "connectors/meeting-bot/schedule/route.ts": "compares node workspace explicitly",
  "webhooks/github/route.ts": "GitHub webhook signature; system ingestion",
  "webhooks/linear/route.ts": "Linear webhook signature; system ingestion",
  "webhooks/slack/route.ts":
    "Slack install HMAC; no request principal to open a workspace with. " +
    "Retrieval is scoped to the install's own grant (lib/auth/install-principal.ts), " +
    "falling back to an explicit systemGrant only for installs with no principal yet.",
  "onboarding/create/route.ts": "creates the workspace it writes to",
  "meetings/attach-transcript/[nodeId]/route.ts": "workspace token only, no user session",
  "meetings/refine/[nodeId]/route.ts": "workspace token only, no user session",
  "meetings/[nodeId]/recording-status/route.ts": "tenancy proved against the node itself",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry === "route.ts" || dir.startsWith(LIB_DIR)) {
      if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
    }
  }
  return out;
}

describe("API routes read through a scoped storage", () => {
  it("do not call getStorage directly", () => {
    const offenders: string[] = [];

    for (const file of walk(API_DIR)) {
      const rel = file.slice(API_DIR.length + 1);
      if (SYSTEM_ROUTES[rel]) continue;

      const src = readFileSync(file, "utf8");
      const callsGetStorage = /\bgetStorage(ById)?\s*\(/.test(src);
      if (callsGetStorage) offenders.push(rel);
    }

    expect(
      offenders,
      `These routes resolve storage themselves, which opts out of the caller's ` +
        `reach. Use openWorkspace() — or, if the route genuinely acts as the ` +
        `system, add it to SYSTEM_ROUTES with a reason.\n  ` +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  it("no library helper hands a route an unscoped storage", () => {
    // The shape: a helper that gates a request AND resolves a storage is acting
    // as a route boundary, so it has to go through openWorkspace like one.
    const offenders: string[] = [];
    for (const file of walk(LIB_DIR)) {
      const rel = file.slice(LIB_DIR.length + 1);
      if (LIB_HELPERS_EXEMPT[rel]) continue;
      const src = readFileSync(file, "utf8");
      const gatesARequest = /\bgate\s*\(\s*req/.test(src);
      const resolvesStorage = /\bgetStorage(ById)?\s*\(/.test(src);
      if (gatesARequest && resolvesStorage) offenders.push(rel);
    }
    expect(
      offenders,
      `These library helpers gate a request and resolve their own storage, ` +
        `which hands the caller an unscoped one. Use openWorkspace.\n  ` +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  it("keeps the system exemption list honest", () => {
    // An entry that no longer matches a real route is stale and hides the fact
    // that the exemption was never re-examined.
    const existing = new Set(walk(API_DIR).map((f) => f.slice(API_DIR.length + 1)));
    const stale = Object.keys(SYSTEM_ROUTES).filter((r) => !existing.has(r));
    expect(stale, `SYSTEM_ROUTES entries for routes that no longer exist`).toEqual([]);
  });
});
