/**
 * Route handlers and `src/lib` speak `Request` and `Response`, not Next.
 *
 * F04 moves the API out of Next and into Hono, one group of routes at a time.
 * What makes that a move rather than a rewrite is that a handler which only
 * touches web-standard objects does not know who is serving it — Next today,
 * Hono tomorrow, the same file. The coupling measured before this guard was
 * three habits, not an architecture: `NextResponse.json` (519 uses),
 * `req.nextUrl.searchParams` (46) and `NextResponse.redirect` (20). All three
 * have standard spellings, and the codemod that replaced them is done.
 *
 * This keeps them from coming back. The F01 worker learned the same lesson
 * mechanically (`build:worker` fails on any `next/*` in the bundle); this is
 * the same rule, applied earlier, to the code the API build will consume.
 *
 * `EXEMPT` named the real couplings left during F04; after the F06 split it
 * is empty, and this test is what keeps it that way.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(process.cwd(), "src");

const SCANNED = ["app/api", "app/mcp", "app/.well-known", "app/install", "app/llms.txt", "lib"];

const EXEMPT: Record<string, string> = {
  // Empty since the split: the web app — fonts, the cookie-bound session
  // client, the RSC cache — lives in bcontext-web now. Nothing in this
  // repository has a reason to import next/*.
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

describe("routes and lib are framework-neutral", () => {
  const offenders: string[] = [];
  for (const dir of SCANNED) {
    for (const file of walk(join(SRC, dir))) {
      const rel = relative(SRC, file);
      if (rel in EXEMPT) continue;
      const source = readFileSync(file, "utf8");
      const hit = source.match(/from\s+["']next\/[a-z/]+["']|\bNextRequest\b|\bNextResponse\b|\.nextUrl\b/);
      if (hit) offenders.push(`${rel} — ${hit[0]}`);
    }
  }

  it("has no Next-specific request or response handling", () => {
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `These files bind a route or library to Next:\n  ${offenders.join("\n  ")}\n\n` +
          `Use Request/Response, new URL(req.url).searchParams, Response.json and ` +
          `redirectTo from @/lib/http. If the coupling is real, add it to EXEMPT with what removing it takes.`,
    ).toEqual([]);
  });

  it("keeps the exemption list honest", () => {
    for (const [rel, reason] of Object.entries(EXEMPT)) {
      const source = readFileSync(join(SRC, rel), "utf8");
      expect(/from\s+["']next\//.test(source), `${rel} no longer imports next/*`).toBe(true);
      expect(reason.length, `${rel} needs a real reason`).toBeGreaterThan(20);
    }
  });
});
