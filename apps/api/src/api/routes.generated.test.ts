/**
 * The generated route table matches the filesystem.
 *
 * `routes.generated.ts` is committed so the API bundle and the type-checker
 * see it, and `build:api` regenerates it — but a test run does not. A route
 * file added without re-running the generator would be served by Next and
 * silently absent from the API process, which is the one failure mode this
 * whole phase is arranged to make loud.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("routes.generated.ts", () => {
  it("is what the generator would write right now", () => {
    const files = ["src/api/routes.generated.ts", "src/api/paths.generated.ts", "../../packages/contract/src/api-paths.generated.ts"].map((f) => join(process.cwd(), f));
    const committed = files.map((f) => readFileSync(f, "utf8"));
    execFileSync("node", ["scripts/gen-api-routes.mjs"], { cwd: process.cwd(), stdio: "ignore" });
    files.forEach((f, i) => {
      expect(readFileSync(f, "utf8"), `${f}: run npm run gen:api-routes and commit the result`).toBe(committed[i]);
    });
  });
});
