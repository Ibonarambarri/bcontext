/**
 * Bundles the API process into a single CommonJS file (`dist/api.cjs`),
 * exactly as the worker and the error collector are bundled, and for the same
 * two reasons: the runner stage of the Dockerfile copies one file per process
 * rather than a `node_modules` tree, and the bundle is where "nothing here
 * imports next/* or react" is enforced mechanically — the API is
 * framework-neutral and must stay that way.
 *
 * Runs as part of `npm run build` (`build:api`); needs only the checkout and
 * `node_modules`. Regenerates the route table first, so the bundle can never
 * serve a stale view of the filesystem.
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";

execFileSync("node", ["scripts/gen-api-routes.mjs"], { stdio: "inherit" });

const result = await build({
  entryPoints: ["src/api/main.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  outfile: "dist/api.cjs",
  sourcemap: true,
  metafile: true,
  tsconfig: "tsconfig.json",
  external: ["pg-native"],
  logLevel: "info",
});

const offenders = Object.keys(result.metafile.inputs).filter(
  // Inputs are relative to apps/api, so hoisted packages show up as
  // `../../node_modules/…`: match the segment, not the prefix.
  (f) => /(^|\/)node_modules\/(next\/|react)/.test(f) || f === "next",
);
if (offenders.length > 0) {
  console.error(
    "\nAPI bundle violation: it pulls Next or React.\n" +
      offenders.slice(0, 15).map((o) => `  - ${o}`).join("\n") +
      (offenders.length > 15 ? `\n  … and ${offenders.length - 15} more` : ""),
  );
  // Show the first importer chain so the fix is one grep away.
  const inputs = result.metafile.inputs;
  const first = offenders[0];
  const importer = Object.entries(inputs).find(([, v]) => v.imports.some((i) => i.path === first));
  if (importer) console.error(`\n  first pulled in by: ${importer[0]}`);
  process.exit(1);
}
console.log("api bundle ok — no next/* or react in the graph");
