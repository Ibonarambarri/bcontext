import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseNangoWebhook, verifyNangoSignature, workspaceIdFromWebhook } from "./webhook";
import { splitIntegrationKey, workspaceMatchesHex } from "./own-app";

const body = JSON.stringify({
  type: "auth",
  operation: "creation",
  connectionId: "conn-1",
  providerConfigKey: "jira",
  success: true,
  tags: { end_user_id: "ws-1" },
});

describe("Nango webhook", () => {
  it("parses an auth creation event and finds the workspace", () => {
    const hook = parseNangoWebhook(body);
    expect(hook?.connectionId).toBe("conn-1");
    expect(workspaceIdFromWebhook(hook!)).toBe("ws-1");
    expect(parseNangoWebhook('{"type":"sync"}')).toBeNull();
    expect(parseNangoWebhook("not json")).toBeNull();
    expect(workspaceIdFromWebhook({ ...hook!, tags: undefined, endUser: { endUserId: "ws-2" } })).toBe("ws-2");
  });

  it("requires the HMAC when a signing key is configured", () => {
    const good = createHmac("sha256", "signing").update(body).digest("hex");
    expect(verifyNangoSignature(body, { "x-nango-hmac-sha256": good }, { webhookSecret: "signing" })).toBe("hmac_ok");
    expect(verifyNangoSignature(body, { "x-nango-hmac-sha256": "00" }, { webhookSecret: "signing" })).toBe("invalid");
    expect(verifyNangoSignature(body, {}, { webhookSecret: "signing" })).toBe("invalid");
  });

  it("accepts the legacy signature and reports unsigned otherwise", () => {
    const legacy = createHash("sha256").update(`sk${body}`).digest("hex");
    expect(verifyNangoSignature(body, { "x-nango-signature": legacy }, { secretKey: "sk" })).toBe("legacy_ok");
    expect(verifyNangoSignature(body, { "x-nango-signature": "ff" }, { secretKey: "sk" })).toBe("invalid");
    expect(verifyNangoSignature(body, {}, { secretKey: "sk" })).toBe("unsigned");
  });

  it("resolves an own-app providerConfigKey back to the connector and checks the workspace", () => {
    const ws = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
    const own = parseNangoWebhook(JSON.stringify({ type: "auth", operation: "creation", connectionId: "c", providerConfigKey: `hubspot--${ws.replace(/-/g, "")}`, tags: { end_user_id: ws } }));
    const split = splitIntegrationKey(own!.providerConfigKey);
    expect(split.connectorKey).toBe("hubspot");
    expect(workspaceMatchesHex(workspaceIdFromWebhook(own!)!, split.workspaceHex)).toBe(true);
    expect(workspaceMatchesHex("00000000-0000-4000-8000-000000000000", split.workspaceHex)).toBe(false);
  });
});
