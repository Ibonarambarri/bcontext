import { describe, expect, it } from "vitest";
import { verifyLinearSignature } from "./index";

describe("linear — verifyLinearSignature", () => {
  const secret = "linear-test-secret";
  const body = '{"webhookId":"abc","type":"Issue","action":"create","data":{}}';

  async function sign(): Promise<string> {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const out = await crypto.subtle.sign("HMAC", key, enc.encode(body));
    return Array.from(new Uint8Array(out))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  it("accepts a valid hex digest", async () => {
    const sig = await sign();
    expect(await verifyLinearSignature(secret, body, sig)).toBe(true);
  });

  it("rejects on wrong secret", async () => {
    const sig = await sign();
    expect(await verifyLinearSignature("other-secret", body, sig)).toBe(false);
  });

  it("rejects empty header", async () => {
    expect(await verifyLinearSignature(secret, body, "")).toBe(false);
  });
});
