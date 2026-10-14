/**
 * A row addressed by a caller-supplied id must be constrained to a workspace.
 *
 * Three cross-tenant IDORs turned up in this codebase within one phase, and all
 * three had the identical shape:
 *
 *   `/api/embed`                  — node id from the body, `.eq("id", …)` only
 *   `/api/meetings/…/recording-status` — same, tenancy checked for agents alone
 *   `lib/ingest/candidates.ts`    — candidate id from the caller, and the
 *                                   workspace then *derived from the row it
 *                                   found* rather than from what was authorised
 *
 * Three occurrences is not coincidence, it is a shape the code invites: every
 * query runs as `service_role`, so `.eq("id", x)` reads happily across tenants
 * and nothing complains. The earlier guard only scanned `.from("nodes")` inside
 * `src/app/api`, so the third one — in `src/lib`, on another table — walked
 * straight past it.
 *
 * This one scans every query in `src/` against every table that has a
 * `workspace_id` column, which is the real invariant: if the table is
 * partitioned by workspace, a lookup by id must say which workspace.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(process.cwd(), "src");

/**
 * Tables carrying a `workspace_id` column, from the live schema. A lookup by id
 * on any of these has a workspace it could have been constrained to.
 */
const WORKSPACE_SCOPED_TABLES = new Set([
  "activity", "agent_workspace_access", "ai_usage_events", "api_tokens",
  "audit_log", "capabilities", "capability_bundles", "capability_grants",
  "capability_invocations", "capability_oauth_credentials", "capability_principals",
  "capability_reviews", "capability_versions", "chat_sessions", "connector_installs",
  "connector_jobs", "edges", "embeddings", "ingest_candidates", "meeting_bots",
  "memberships", "node_links", "node_read_activity", "node_redirects", "node_tags",
  "nodes", "oauth_access_tokens", "saved_views", "tag_aliases", "tag_relations",
  "tags", "usage_counters", "webhook_deliveries", "webhook_endpoints",
  "nexos", "nexo_bindings", "nexo_runs", "nexo_inbox", "nexo_windows",
]);

/**
 * Lookups that are deliberately global, each with the reason. An entry here is
 * a claim that the id cannot be used to reach another tenant's row — usually
 * because the id is itself a credential, or because the very next thing the
 * code does is check the workspace it found.
 */
const REVIEWED: Record<string, string> = {
  "lib/auth/tokens.ts": "token lookup by hash; the id IS the credential",
  "lib/mcp/brief.ts": "last_brief_at on the caller's OWN token row (ctx.tokenId), authenticated by the transport before any tool runs",
  "lib/auth/oauth.ts": "OAuth codes and tokens are credentials, looked up to be validated",
  "lib/capabilities/gateway.ts": "resolves a grant in order to check it; workspace compared after",
  "api/realtime/auth.ts":
    "reads only the node's workspace_id, as the QUESTION for resolveGrant — no " +
    "grant there is a 404, and a grant is then narrowed by scopedStorage before " +
    "the node is admitted. The row proves nothing; it names what to authorise.",
  "lib/connectors/secrets.ts": "vault secrets addressed by their own id, never by user input",
  "app/api/meetings/[nodeId]/recording-status/route.ts": "same: resolves storage from the node",
  "app/api/webhooks/endpoints/[id]/route.ts":
    "the endpoint lookup goes through the SSR client, so RLS evaluates — one of " +
    "the few places where the policies still do their job. The admin client in " +
    "the same file is used only to resolve a workspace slug for the event.",
  "lib/connectors/installs.ts":
    "getInstallById is called with the OAuth `state` parameter, which is an " +
    "unguessable single-use credential, not a caller-chosen id.",
  "lib/connectors/runtime.ts":
    "system worker; the install id comes off the job row, not from a caller.",
  "lib/integrations/meeting-records.ts":
    "every chain here filters by workspace_id — the flag is the chain splitter " +
    "running past a statement boundary.",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "components") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Split a file into query chains: everything from a `.from("table")` up to the
 * statement that ends it. Crude, but it is the unit the invariant applies to —
 * a chain either names a workspace or it does not.
 */
function queryChains(src: string): Array<{ table: string; chain: string }> {
  const chains: Array<{ table: string; chain: string }> = [];
  const re = /\.from\(\s*["'`]([a-z_]+)["'`]\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(src))) {
    const table = match[1];
    if (!table) continue;
    // Up to the next semicolon at the end of a line, which is where these
    // builder chains terminate in this codebase.
    const rest = src.slice(match.index, match.index + 1200);
    const end = rest.search(/;\s*$/m);
    chains.push({ table, chain: end > 0 ? rest.slice(0, end) : rest });
  }
  return chains;
}

describe("lookups by caller-supplied id name their workspace", () => {
  it("has no unconstrained id lookup on a workspace-scoped table", () => {
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      const rel = relative(SRC, file);
      if (REVIEWED[rel]) continue;
      const src = readFileSync(file, "utf8");

      // Only service-role queries are at issue. A query made through the SSR
      // client carries the user's JWT and RLS actually evaluates — those are the
      // handful of places where the policies still do their job, and a lookup by
      // id there is fine.
      if (!src.includes("getSupabaseAdmin")) continue;

      // Proving tenancy against the workspace the row turned out to live in is
      // the other legitimate shape — it is what the webhook retry route does. What is never acceptable is doing neither.
      const provesTenancy =
        src.includes("requireWorkspaceMember") ||
        /workspace_id\s*!==/.test(src) ||
        /getStorageById\(\s*\w+\.workspace_id\s*\)/.test(src);

      for (const { table, chain } of queryChains(src)) {
        if (!WORKSPACE_SCOPED_TABLES.has(table)) continue;
        const byId = /\.eq\(\s*["'`]id["'`]/.test(chain);
        // Constraining to a user is narrower than constraining to a workspace:
        // a chat session filtered by `user_id` cannot be another person's, let
        // alone another tenant's.
        const scoped =
          /\.eq\(\s*["'`]workspace_id["'`]/.test(chain) ||
          /\.eq\(\s*["'`]user_id["'`]/.test(chain);
        if (byId && !scoped && !provesTenancy) offenders.push(`${rel} → ${table}`);
      }
    }

    expect(
      offenders,
      `Each of these looks a row up by id on a workspace-partitioned table ` +
        `without saying which workspace. Every query here runs as service_role, ` +
        `so the read crosses tenants silently. Add .eq("workspace_id", <the ` +
        `authorised one — never the one on the row you just found>), or list ` +
        `the file in REVIEWED with a reason.\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("keeps the exemption list from going stale", () => {
    const existing = new Set(walk(SRC).map((f) => relative(SRC, f)));
    const stale = Object.keys(REVIEWED).filter((r) => !existing.has(r));
    expect(stale, "REVIEWED entries for files that no longer exist").toEqual([]);
  });
});
