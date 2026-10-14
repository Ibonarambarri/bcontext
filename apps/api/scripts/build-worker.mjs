/**
 * Bundles the pg-boss worker into a single self-contained CommonJS file.
 *
 * Why bundle instead of shipping `src/` + `node_modules`: the runner stage of
 * the Dockerfile copies one file per process (`api.js`, `worker.js`,
 * `errors.js`) and no `node_modules` tree, so the worker carries its own
 * dependencies inside `dist/worker.cjs` and the runner stage stays a single
 * layer.
 *
 * It also enforces the "no framework in the backend" rule mechanically: if
 * anything in the worker's import graph reaches `next/*`, the build fails
 * here rather than at 3am in production. Runs as part of `npm run build`
 * (`build:worker`); needs only the checkout and `node_modules`.
 */
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const result = await build({
  entryPoints: ["src/worker/main.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  outfile: "dist/worker.cjs",
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
  (f) => /(^|\/)node_modules\/next\//.test(f) || f === "next",
);
if (offenders.length > 0) {
  console.error(
    "\nWorker bundle violation: it pulls Next.\n" +
      offenders.map((o) => `  - ${o}`).join("\n"),
  );
  process.exit(1);
}

// Belt and braces: a stray `require("next/...")` that esbuild marked external.
const code = readFileSync("dist/worker.cjs", "utf8");
if (/require\(["']next\//.test(code) || /from ["']next\//.test(code)) {
  console.error("\nWorker bundle violation: dist/worker.cjs references next/* at runtime.");
  process.exit(1);
}

console.log("worker bundle ok — no next/* in the graph");
