/**
 * The web side reaches data only through the API.
 *
 * F06 splits the repository into bcontext-api and bcontext-web. That is only
 * possible if nothing under the UI imports the domain: storage, the permission
 * engine, the org/registry helpers, the admin Supabase client — all of it moves
 * to the API repo and stops existing here. Measured before this guard: 30 UI
 * files imported 13 such modules, most of them one `getSupabaseAdmin()` away
 * from a service-role query in a page.
 *
 * Three rules, all scanned from source so the class is caught, not the
 * instance:
 *   1. UI code imports no DATA module from @/lib (list below).
 *   2. UI code never calls `.from(` on a Supabase client — the session client
 *      is for `auth.*` only, and a query through it would bypass the grant.
 *   3. `@/api/*` is reachable from the UI only through web/api-client.ts,
 *      the transition seam. Nothing else may import the API process.
 *
 * "UI code" is everything under src/app that is not a route handler,
 * everything under src/components, and src/web — the Next-side helpers that
 * mirror src/api and leave with the web repo.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(process.cwd(), "src");

/** Modules whose import graph reaches storage, the admin client or the grant engine. */
const DATA_MODULES =
  /^@\/lib\/(?:supabase\/(?:admin|server)|storage|queue|auth\/(?:require|grants|admin|invitations|workspace|grant-sync|tokens|oauth)|workspaces\/(?:orgs|registry)|demo-store|activity|meetings\/refine-job|ingest\/candidates|admin\/(?:metrics|access)|enterprise\/store|connectors\/(?:installs|secrets)|capabilities\/(?:admin|gateway|catalog)|mcp)(?:\/|$)/;

/**
 * UI files still being migrated. Every entry is work, and the list only
 * shrinks: an agent takes a group, moves it to the API client, and deletes
 * its lines here. When it is empty the web side is ready to leave.
 */
const PENDING: Record<string, string> = {};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

function uiFiles(): string[] {
  const app = walk(join(SRC, "app")).filter((f) => !/\/(api|mcp)\//.test(f) && !/\/route\.ts$/.test(f));
  const components = walk(join(SRC, "components"));
  const web = walk(join(SRC, "web"));
  return [...app, ...components, ...web];
}

describe("web speaks HTTP", () => {
  const offenders: string[] = [];
  for (const file of uiFiles()) {
    const rel = relative(SRC, file);
    if (rel in PENDING) continue;
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(/from\s+["'](@\/(lib|api)\/[^"']+|@\/api)["']/g)) {
      const spec = m[1]!;
      if (spec.startsWith("@/api")) {
        if (rel !== "web/api-client.ts") offenders.push(`${rel} — imports ${spec} (only api-client.ts may)`);
      } else if (DATA_MODULES.test(spec)) {
        offenders.push(`${rel} — imports ${spec}`);
      }
    }
    if (/\.from\(\s*["']/.test(source)) offenders.push(`${rel} — calls .from("…") on a Supabase client`);
  }

  it("imports no data module and runs no query from the UI", () => {
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `These UI files reach data without the API:\n  ${offenders.join("\n  ")}\n\n` +
          `Use apiFetch/apiJson from @/web/api-client (server) or fetch("/api/…") (client). ` +
          `Session only: @/web/session for auth.*. If a route is missing, add it to the API.`,
    ).toEqual([]);
  });

  it("keeps PENDING honest", () => {
    for (const [rel, reason] of Object.entries(PENDING)) {
      expect(reason.length, `${rel} needs a reason`).toBeGreaterThan(10);
      const source = readFileSync(join(SRC, rel), "utf8");
      const imports = [...source.matchAll(/from\s+["'](@\/lib\/[^"']+)["']/g)].map((m) => m[1]!);
      const stillOffends = imports.some((i) => DATA_MODULES.test(i)) || /\.from\(\s*["']/.test(source);
      expect(stillOffends, `${rel} no longer needs to be pending — remove it from PENDING`).toBe(true);
    }
  });
});
