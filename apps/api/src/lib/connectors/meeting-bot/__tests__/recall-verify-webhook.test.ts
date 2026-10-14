import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectorSignatureError } from "@bcontext-dev/contract/connectors/types";
import { recallProvider } from "../recall";

const SECRET = "test-secret-do-not-use-in-prod";

async function sign(ts: string, body: string, key = SECRET): Promise<string> {
  const base = `${ts}.${body}`;
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
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

describe("recallProvider.verifyWebhook", () => {
  const originalSecret = process.env.RECALL_WEBHOOK_SECRET;

  beforeEach(() => {
    process.env.RECALL_WEBHOOK_SECRET = SECRET;
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.RECALL_WEBHOOK_SECRET;
    else process.env.RECALL_WEBHOOK_SECRET = originalSecret;
  });

  it("maps in_call_recording to status_change → in_call", async () => {
    const body = JSON.stringify({
      event: "bot.status_change",
      data: { bot_id: "bot_recording", status: { code: "in_call_recording" } },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const event = await recallProvider.verifyWebhook({
      rawBody: body,
      headers: { "recall-signature": await sign(ts, body) },
    });
    expect(event.kind).toBe("status_change");
    expect(event.externalId).toBe("bot_recording");
    expect(event.status).toBe("in_call");
  });

  it("maps call_ended to status_change → call_ended", async () => {
    const body = JSON.stringify({
      event: "bot.status_change",
      data: { bot_id: "bot_ended", status: { code: "call_ended" } },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const event = await recallProvider.verifyWebhook({
      rawBody: body,
      headers: { "recall-signature": await sign(ts, body) },
    });
    expect(event.status).toBe("call_ended");
  });

  it("maps transcript.done to transcript_ready", async () => {
    const body = JSON.stringify({
      event: "transcript.done",
      data: { bot_id: "bot_done" },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const event = await recallProvider.verifyWebhook({
      rawBody: body,
      headers: { "recall-signature": await sign(ts, body) },
    });
    expect(event.kind).toBe("transcript_ready");
    expect(event.externalId).toBe("bot_done");
    expect(event.status).toBe("done");
  });

  it("maps fatal to status_change → failed", async () => {
    const body = JSON.stringify({
      event: "bot.status_change",
      data: { bot_id: "bot_fatal", status: { code: "fatal" } },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const event = await recallProvider.verifyWebhook({
      rawBody: body,
      headers: { "recall-signature": await sign(ts, body) },
    });
    expect(event.status).toBe("failed");
  });

  it("maps per-status event bot.in_call_recording → in_call", async () => {
    const body = JSON.stringify({
      event: "bot.in_call_recording",
      data: { bot_id: "bot_perstatus" },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const event = await recallProvider.verifyWebhook({
      rawBody: body,
      headers: { "recall-signature": await sign(ts, body) },
    });
    expect(event.kind).toBe("status_change");
    expect(event.status).toBe("in_call");
    expect(event.externalId).toBe("bot_perstatus");
  });

  it("maps per-status event bot.call_ended → call_ended", async () => {
    const body = JSON.stringify({
      event: "bot.call_ended",
      data: { bot_id: "bot_ended2" },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const event = await recallProvider.verifyWebhook({
      rawBody: body,
      headers: { "recall-signature": await sign(ts, body) },
    });
    expect(event.status).toBe("call_ended");
  });

  it("maps per-status event bot.fatal → failed", async () => {
    const body = JSON.stringify({
      event: "bot.fatal",
      data: { bot_id: "bot_dead" },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const event = await recallProvider.verifyWebhook({
      rawBody: body,
      headers: { "recall-signature": await sign(ts, body) },
    });
    expect(event.status).toBe("failed");
  });

  it("ignores irrelevant bot.* events (breakout rooms)", async () => {
    const body = JSON.stringify({
      event: "bot.breakout_room_entered",
      data: { bot_id: "bot_b" },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const event = await recallProvider.verifyWebhook({
      rawBody: body,
      headers: { "recall-signature": await sign(ts, body) },
    });
    expect(event.kind).toBe("ignored");
  });

  it("emits 'ignored' for unrelated events", async () => {
    const body = JSON.stringify({
      event: "calendar.something",
      data: { bot_id: "bot_x" },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const event = await recallProvider.verifyWebhook({
      rawBody: body,
      headers: { "recall-signature": await sign(ts, body) },
    });
    expect(event.kind).toBe("ignored");
  });

  it("throws ConnectorSignatureError when the signature is invalid", async () => {
    const body = JSON.stringify({ event: "bot.status_change", data: { bot_id: "bot_x" } });
    await expect(
      recallProvider.verifyWebhook({
        rawBody: body,
        headers: { "recall-signature": "t=999,v1=badbadbad" },
      }),
    ).rejects.toBeInstanceOf(ConnectorSignatureError);
  });

  it("throws ConnectorSignatureError when the webhook secret is unset", async () => {
    delete process.env.RECALL_WEBHOOK_SECRET;
    const body = JSON.stringify({ event: "bot.status_change", data: { bot_id: "bot_x" } });
    await expect(
      recallProvider.verifyWebhook({ rawBody: body, headers: {} }),
    ).rejects.toBeInstanceOf(ConnectorSignatureError);
  });
});
