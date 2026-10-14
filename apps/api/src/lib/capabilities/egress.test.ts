import { describe, expect, it } from "vitest";
import {
  createPinnedLookup,
  EgressPolicyError,
  resolveSafeTarget,
  withResponseSizeLimit,
} from "./egress";

describe("capability egress policy", () => {
  it("accepts an explicitly allowlisted public address", async () => {
    const target = await resolveSafeTarget("https://8.8.8.8/mcp", ["8.8.8.8"]);
    expect(target.addresses[0]).toEqual({ address: "8.8.8.8", family: 4 });
  });

  it.each([
    "https://127.0.0.1/mcp",
    "https://10.0.0.1/mcp",
    "https://169.254.169.254/latest/meta-data",
    "https://192.168.1.10/hook",
    "https://[::1]/mcp",
    "https://[::ffff:127.0.0.1]/mcp",
  ])("rejects non-public destination %s", async (url) => {
    await expect(resolveSafeTarget(url, [new URL(url).hostname])).rejects.toMatchObject({
      code: "private_address_forbidden",
    } satisfies Partial<EgressPolicyError>);
  });

  it("requires HTTPS and an exact host allowlist match", async () => {
    await expect(resolveSafeTarget("http://8.8.8.8/mcp", ["8.8.8.8"]))
      .rejects.toMatchObject({ code: "https_required" });
    await expect(resolveSafeTarget("https://8.8.8.8/mcp", ["example.com"]))
      .rejects.toMatchObject({ code: "host_not_allowed" });
  });

  it("returns the array callback shape for all-address lookups", async () => {
    const lookup = createPinnedLookup({ address: "8.8.8.8", family: 4 });
    const result = await new Promise<unknown>((resolve, reject) => {
      lookup("example.com", { all: true }, (error, address) => {
        if (error) reject(error);
        else resolve(address);
      });
    });
    expect(result).toEqual([{ address: "8.8.8.8", family: 4 }]);
  });

  it("returns the single-address callback shape when all is false", async () => {
    const lookup = createPinnedLookup({ address: "8.8.8.8", family: 4 });
    const result = await new Promise<unknown>((resolve, reject) => {
      lookup("example.com", { all: false }, (error, address, family) => {
        if (error) reject(error);
        else resolve({ address, family });
      });
    });
    expect(result).toEqual({ address: "8.8.8.8", family: 4 });
  });

  it("rejects a declared response larger than the limit before buffering it", async () => {
    const limited = withResponseSizeLimit(async () => new Response("oversized", {
      headers: { "content-length": "999" },
    }), 8);
    await expect(limited("https://8.8.8.8/mcp")).rejects.toMatchObject({
      code: "response_too_large",
    } satisfies Partial<EgressPolicyError>);
  });

  it("stops an unbounded streaming response at the byte limit", async () => {
    const limited = withResponseSizeLimit(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("12345"));
        controller.enqueue(new TextEncoder().encode("67890"));
        controller.close();
      },
    })), 8);
    const response = await limited("https://8.8.8.8/mcp");
    await expect(response.text()).rejects.toMatchObject({
      code: "response_too_large",
    } satisfies Partial<EgressPolicyError>);
  });

  it("preserves status, headers and body below the limit", async () => {
    const limited = withResponseSizeLimit(async () => new Response("ok", {
      status: 201,
      headers: { "x-provider": "safe" },
    }), 8);
    const response = await limited("https://8.8.8.8/mcp");
    expect(response.status).toBe(201);
    expect(response.headers.get("x-provider")).toBe("safe");
    await expect(response.text()).resolves.toBe("ok");
  });
});
