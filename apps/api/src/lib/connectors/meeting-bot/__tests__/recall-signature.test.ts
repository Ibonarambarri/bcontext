import { describe, expect, it } from "vitest";
import { verifyRecallSignature } from "../recall";

const SECRET_RAW_BYTES = new Uint8Array([
  0x1f, 0x2e, 0x3d, 0x4c, 0x5b, 0x6a, 0x79, 0x88,
  0x97, 0xa6, 0xb5, 0xc4, 0xd3, 0xe2, 0xf1, 0x00,
  0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
  0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x01,
]);
const SECRET_B64 = Buffer.from(SECRET_RAW_BYTES).toString("base64");
const SECRET = `whsec_${SECRET_B64}`;

const body = JSON.stringify({
  type: "bot.in_call_recording",
  data: { bot_id: "bot_svix_123" },
});

async function svixSign(
  svixId: string,
  ts: string,
  payload: string,
  keyBytes: Uint8Array = SECRET_RAW_BYTES,
): Promise<string> {
  const signedContent = `${svixId}.${ts}.${payload}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(signedContent));
  return Buffer.from(new Uint8Array(sig)).toString("base64");
}

describe("verifyRecallSignature (Svix scheme)", () => {
  it("accepts a fresh, correctly-signed Svix webhook", async () => {
    const svixId = "msg_2k9aBcd";
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await svixSign(svixId, ts, body);
    const ok = await verifyRecallSignature(SECRET, {
      rawBody: body,
      headers: {
        "svix-id": svixId,
        "svix-timestamp": ts,
        "svix-signature": `v1,${sig}`,
      },
    });
    expect(ok).toBe(true);
  });

  it("rejects a stale Svix request (> 5 min old)", async () => {
    const svixId = "msg_old";
    const ts = String(Math.floor(Date.now() / 1000) - 60 * 10);
    const sig = await svixSign(svixId, ts, body);
    const ok = await verifyRecallSignature(SECRET, {
      rawBody: body,
      headers: {
        "svix-id": svixId,
        "svix-timestamp": ts,
        "svix-signature": `v1,${sig}`,
      },
    });
    expect(ok).toBe(false);
  });

  it("rejects a tampered body", async () => {
    const svixId = "msg_tampered";
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await svixSign(svixId, ts, body);
    const ok = await verifyRecallSignature(SECRET, {
      rawBody: body + '{"injected":true}',
      headers: {
        "svix-id": svixId,
        "svix-timestamp": ts,
        "svix-signature": `v1,${sig}`,
      },
    });
    expect(ok).toBe(false);
  });

  it("rejects when svix headers are missing", async () => {
    const ok = await verifyRecallSignature(SECRET, {
      rawBody: body,
      headers: {},
    });
    expect(ok).toBe(false);
  });

  it("rejects a signature signed with the wrong secret", async () => {
    const svixId = "msg_wrongkey";
    const ts = String(Math.floor(Date.now() / 1000));
    const otherKey = new Uint8Array(32).fill(0xab);
    const sig = await svixSign(svixId, ts, body, otherKey);
    const ok = await verifyRecallSignature(SECRET, {
      rawBody: body,
      headers: {
        "svix-id": svixId,
        "svix-timestamp": ts,
        "svix-signature": `v1,${sig}`,
      },
    });
    expect(ok).toBe(false);
  });

  it("accepts when multiple v1 signatures are present (key rotation)", async () => {
    const svixId = "msg_rot";
    const ts = String(Math.floor(Date.now() / 1000));
    const valid = await svixSign(svixId, ts, body);
    const ok = await verifyRecallSignature(SECRET, {
      rawBody: body,
      headers: {
        "svix-id": svixId,
        "svix-timestamp": ts,
        "svix-signature": `v1,wrongbutformatted v1,${valid}`,
      },
    });
    expect(ok).toBe(true);
  });

  it("accepts secrets without the whsec_ prefix (already base64)", async () => {
    const svixId = "msg_noprefix";
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await svixSign(svixId, ts, body);
    const ok = await verifyRecallSignature(SECRET_B64, {
      rawBody: body,
      headers: {
        "svix-id": svixId,
        "svix-timestamp": ts,
        "svix-signature": `v1,${sig}`,
      },
    });
    expect(ok).toBe(true);
  });
});

describe("verifyRecallSignature (legacy recall-signature fallback)", () => {
  const legacySecret = "ab12cd34ef56gh78ij90klmnopqrstuv";
  const legacyBody = JSON.stringify({
    event: "bot.status_change",
    data: { bot_id: "bot_legacy", status: { code: "in_call_recording" } },
  });

  async function legacySign(ts: string, payload: string = legacyBody): Promise<string> {
    const base = `${ts}.${payload}`;
    const enc = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      enc.encode(legacySecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(base));
    const hex = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return `t=${ts},v1=${hex}`;
  }

  it("still accepts the legacy recall-signature header form", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const header = await legacySign(ts);
    const ok = await verifyRecallSignature(legacySecret, {
      rawBody: legacyBody,
      headers: { "recall-signature": header },
    });
    expect(ok).toBe(true);
  });
});
