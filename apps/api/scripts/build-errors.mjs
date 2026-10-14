/**
 * Bundles the error collector into a single self-contained CommonJS file,
 * exactly as the worker and the API are bundled, and for the same two
 * reasons: the runner stage copies one file per process rather than a
 * `node_modules` tree, and the bundle is where "nothing here imports next/*"
 * stops being a convention and becomes a build failure.
 *
 * The collector is the process where that rule matters most in practice: it
 * has to keep running while the rest of the fleet is broken, so its
 * dependency graph is worth being able to see in one file.
 *
 * Runs as part of `npm run build` (`build:errors`); needs only the checkout
 * and `node_modules`. Output: `dist/errors.cjs` (`node errors.js` in the
 * image, `BCONTEXT_PROCESS=errors`).
 */
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const result = await build({
  entryPoints: ["src/errors/main.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  outfile: "dist/errors.cjs",
  sourcemap: true,
  metafile: true,
  tsconfig: "tsconfig.json",
  // Optional native accelerator for `pg`; absent by design.
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
    "\nErrors bundle violation: it pulls Next or React.\n" +
      offenders.slice(0, 15).map((o) => `  - ${o}`).join("\n") +
      (offenders.length > 15 ? `\n  … and ${offenders.length - 15} more` : ""),
  );
  // Show the first importer chain so the fix is one grep away.
  const first = offenders[0];
  const importer = Object.entries(result.metafile.inputs).find(([, v]) =>
    v.imports.some((i) => i.path === first),
  );
  if (importer) console.error(`\n  first pulled in by: ${importer[0]}`);
  process.exit(1);
}

// Belt and braces: a stray `require("next/...")` that esbuild marked external.
const code = readFileSync("dist/errors.cjs", "utf8");
if (/require\(["']next\//.test(code) || /from ["']next\//.test(code)) {
  console.error("\nErrors bundle violation: dist/errors.cjs references next/* at runtime.");
  process.exit(1);
}

console.log("errors bundle ok — no next/* in the graph");
