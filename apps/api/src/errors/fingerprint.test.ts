import { describe, expect, it } from "vitest";
import { fingerprintFor, normalizeFrame, normalizeMessage, stackFrames } from "./fingerprint";

/** A stack as V8 prints it inside the container, with the parts that move
 *  between two occurrences of one bug: line numbers and a request uuid. */
function stack(line: number, uuid: string): string {
  return [
    "TypeError: cannot read properties of undefined",
    `    at writeNode (/app/src/lib/nodes/write.ts:${line}:15)`,
    `    at async handler (/app/src/app/api/nodes/route.ts:${line + 40}:3)`,
    `    at async mountRoute (/app/src/api/adapter.ts:88:9)`,
    `    at async requestFor (/app/src/api/adapter.ts:12:9) [${uuid}]`,
  ].join("\n");
}

describe("normalizeFrame", () => {
  it("drops the absolute prefix, the line and the column", () => {
    expect(normalizeFrame("    at writeNode (/app/src/lib/nodes/write.ts:120:15)")).toBe(
      "writeNode@nodes/write.ts",
    );
  });

  it("agrees between a container path and a laptop path", () => {
    expect(normalizeFrame("at handler (/app/src/lib/nodes/write.ts:1:2)")).toBe(
      normalizeFrame("at handler (/Users/dev/bcontext/src/lib/nodes/write.ts:900:41)"),
    );
  });

  it("collapses a bundle hash and the origin of a browser frame", () => {
    expect(normalizeFrame("at onClick (https://app.example.com/_next/static/chunks/4f3a2b1cdd.js:1:2401)")).toBe(
      normalizeFrame("at onClick (https://app.example.com/_next/static/chunks/99aa77bc01.js:1:9)"),
    );
  });

  it("keeps a frame with no function name", () => {
    expect(normalizeFrame("at /app/dist/api.cjs:41822:9")).toBe("dist/api.cjs");
  });
});

describe("normalizeMessage", () => {
  it("replaces the parts that differ between two occurrences", () => {
    const a = normalizeMessage("node 8f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f not found (3 tries)");
    const b = normalizeMessage("node 11112222-3333-4444-5555-666677778888 not found (9 tries)");
    expect(a).toBe(b);
    expect(a).toContain("<uuid>");
  });

  it("placeholders quoted values, emails and urls", () => {
    expect(normalizeMessage(`column "slug_v2" does not exist`)).toBe("column <str> does not exist");
    expect(normalizeMessage("invite to someone@example.com failed")).toBe("invite to <email> failed");
    expect(normalizeMessage("fetch https://api.x.dev/a/b?t=1 failed")).toBe("fetch <url> failed");
  });
});

describe("stackFrames", () => {
  it("takes three frames and ignores the header line", () => {
    const frames = stackFrames(stack(120, "aaaabbbb-cccc-dddd-eeee-ffff00001111"));
    expect(frames).toHaveLength(3);
    expect(frames[0]).toBe("writeNode@nodes/write.ts");
  });
});

describe("fingerprintFor", () => {
  const base = { service: "api", operation: "rest:POST /api/nodes", error_type: "TypeError" };

  it("is 32 hex characters", () => {
    const fp = fingerprintFor({ ...base, message: "boom", stack: stack(1, "a") });
    expect(fp).toMatch(/^[0-9a-f]{32}$/);
  });

  it("groups two occurrences of the same bug", () => {
    const a = fingerprintFor({
      ...base,
      message: "cannot read properties of undefined (reading 'id')",
      stack: stack(120, "aaaabbbb-cccc-dddd-eeee-ffff00001111"),
    });
    const b = fingerprintFor({
      ...base,
      // Different line numbers (a commit landed), different request uuid,
      // different variable part of the message. Same bug.
      message: "cannot read properties of undefined (reading 'slug')",
      stack: stack(131, "99998888-7777-6666-5555-444433332222"),
    });
    expect(a).toBe(b);
  });

  it("separates two different bugs in the same operation", () => {
    const a = fingerprintFor({ ...base, message: "boom", stack: stack(120, "x") });
    const b = fingerprintFor({
      ...base,
      message: "boom",
      stack: "Error: boom\n    at deleteNode (/app/src/lib/nodes/delete.ts:9:1)",
    });
    expect(a).not.toBe(b);
  });

  it("separates the same stack reached from two operations", () => {
    const s = stack(120, "x");
    expect(fingerprintFor({ ...base, message: "boom", stack: s })).not.toBe(
      fingerprintFor({ ...base, operation: "mcp.tool:nodes_write", message: "boom", stack: s }),
    );
  });

  it("separates the same stack in two services", () => {
    const s = stack(120, "x");
    expect(fingerprintFor({ ...base, message: "boom", stack: s })).not.toBe(
      fingerprintFor({ ...base, service: "worker", message: "boom", stack: s }),
    );
  });

  it("separates two error types with the same stack", () => {
    const s = stack(120, "x");
    expect(fingerprintFor({ ...base, message: "boom", stack: s })).not.toBe(
      fingerprintFor({ ...base, error_type: "RangeError", message: "boom", stack: s }),
    );
  });

  it("falls back to the normalised message when there is no stack", () => {
    const a = fingerprintFor({ ...base, message: "node 8f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f missing" });
    const b = fingerprintFor({ ...base, message: "node 11112222-3333-4444-5555-666677778888 missing" });
    const c = fingerprintFor({ ...base, message: "workspace missing" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("does not let a stackless report land on a stacked one", () => {
    const s = stack(120, "x");
    expect(fingerprintFor({ ...base, message: "boom", stack: s })).not.toBe(
      fingerprintFor({ ...base, message: "boom" }),
    );
  });
});
