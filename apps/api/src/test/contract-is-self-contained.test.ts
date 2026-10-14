/**
 * The contract package depends on nothing outside itself.
 *
 * `@bcontext-dev/contract` is what bcontext-web installs from the registry
 * once the repositories are split. A module in it that reaches for `@/lib`
 * or `@/api` compiles fine in the monorepo — the path alias resolves — and
 * fails the moment it is published, in the other repo, where those paths do
 * not exist. So: only relative imports within the package, and packages
 * declared in its own package.json.
 *
 * The scan is textual on purpose (esbuild drops `import type`, which is most
 * of what a contract is) — which is also why comments come out first: a
 * sentence like `tell "no data" from "zero"` in a doc comment is, to a regex,
 * indistinguishable from an import of a package called `zero`.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const PKG = join(process.cwd(), "../../packages/contract");
const SRC = join(PKG, "src");

/**
 * Source with its comments removed. Block comments first, then line comments.
 * A `//` outside a comment only ever appears inside a string (a URL), and no
 * import specifier contains one, so nothing the scan cares about is lost.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (/\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)) out.push(f);
  }
  return out;
}

describe("@bcontext-dev/contract", () => {
  const manifest = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  const declared = new Set(Object.keys(manifest.dependencies ?? {}));

  it("imports nothing through the repo's path aliases", () => {
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      const s = code(readFileSync(f, "utf8"));
      for (const m of s.matchAll(/(?:from\s+|import\s*\(\s*)["'](@\/[^"']+)["']/g)) {
        offenders.push(`${relative(PKG, f)} → ${m[1]}`);
      }
    }
    expect(offenders, "these would break the published package").toEqual([]);
  });

  it("declares every package it imports", () => {
    const missing = new Set<string>();
    for (const f of walk(SRC)) {
      const s = code(readFileSync(f, "utf8"));
      for (const m of s.matchAll(/(?:from\s+|import\s*\(\s*)["']([^."'/@][^"']*|@[^/"']+\/[^"']+)["']/g)) {
        const spec = m[1]!;
        if (spec.startsWith("node:")) continue;
        const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
        if (!declared.has(name)) missing.add(name);
      }
    }
    expect([...missing], "add to packages/contract/package.json dependencies").toEqual([]);
  });

  it("never imports a framework or a database client", () => {
    const banned = /["'](next(\/|$)|react(\/|$)|@supabase\/|pg(\/|$)|pg-boss|hono(\/|$)|ws(\/|$))/;
    const offenders = walk(SRC).filter((f) => banned.test(code(readFileSync(f, "utf8")))).map((f) => relative(PKG, f));
    expect(offenders).toEqual([]);
  });
});
