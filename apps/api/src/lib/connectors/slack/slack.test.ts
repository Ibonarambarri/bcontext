import { describe, expect, it } from "vitest";
import { verifySlackSignature } from "./index";

describe("slack — verifySlackSignature", () => {
  const secret = "8f742231b10e8888abcd99yyyzzz85a5";
  const body = "token=xxx&team_id=T1&command=%2Fbcontext&text=search+ping";

  async function signWith(ts: string): Promise<string> {
    const base = `v0:${ts}:${body}`;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(base));
    const hex = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return `v0=${hex}`;
  }

  it("accepts a fresh, correctly-signed request", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await signWith(ts);
    const ok = await verifySlackSignature(secret, {
      rawBody: body,
      headers: {
        "x-slack-request-timestamp": ts,
        "x-slack-signature": sig,
      },
    });
    expect(ok).toBe(true);
  });

  it("rejects a stale request (> 5 min old)", async () => {
    const ts = String(Math.floor(Date.now() / 1000) - 60 * 10);
    const sig = await signWith(ts);
    const ok = await verifySlackSignature(secret, {
      rawBody: body,
      headers: {
        "x-slack-request-timestamp": ts,
        "x-slack-signature": sig,
      },
    });
    expect(ok).toBe(false);
  });

  it("rejects a tampered body", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await signWith(ts);
    const ok = await verifySlackSignature(secret, {
      rawBody: body + "&extra=evil",
      headers: {
        "x-slack-request-timestamp": ts,
        "x-slack-signature": sig,
      },
    });
    expect(ok).toBe(false);
  });

  it("rejects when headers are missing", async () => {
    const ok = await verifySlackSignature(secret, { rawBody: body, headers: {} });
    expect(ok).toBe(false);
  });
});
