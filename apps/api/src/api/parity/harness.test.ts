import { describe, expect, it } from "vitest";
import { createApiApp } from "../app";
import { both, expectParity, stable } from "./harness";
import * as health from "@/app/api/health/route";

describe("parity harness", () => {
  it("notices when the API process does not serve the route", async () => {
    // Guard the guard: an app that serves nothing must fail parity loudly,
    // or a whole group could be promoted on tests that compared 404 to 404.
    const empty = createApiApp({ serve: [] });
    const result = await both(empty, health, { method: "GET", path: "/api/health" });
    expect(result.direct.status).toBe(200);
    expect(result.viaHono.status).toBe(404);
    expect(() => expectParity(result)).toThrow(/status differs/);
  });

  it("blanks volatile fields by type, not by value", () => {
    expect(stable({ id: "a", nested: [{ id: "b", ts: 1, keep: "x" }] })).toEqual({
      id: "string",
      nested: [{ id: "string", ts: "number", keep: "x" }],
    });
  });
});
