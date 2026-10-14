import { describe, expect, it, vi } from "vitest";
import { NangoError, type NangoClient } from "./client";
import {
  deleteOwnOAuthApp,
  installIntegrationKey,
  installOAuthAppKind,
  ownIntegrationKey,
  splitIntegrationKey,
  upsertOwnOAuthApp,
  withIntegrationKey,
  workspaceMatchesHex,
} from "./own-app";

const WS = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

function fakeClient(overrides: Partial<Record<keyof NangoClient, unknown>> = {}) {
  return {
    getIntegration: vi.fn(async () => null),
    createIntegration: vi.fn(async (i: { uniqueKey: string }) => ({ uniqueKey: i.uniqueKey, provider: "x", displayName: null })),
    updateIntegration: vi.fn(async (k: string) => ({ uniqueKey: k, provider: "x", displayName: null })),
    deleteIntegration: vi.fn(async () => true),
    proxy: vi.fn(async (req: { providerConfigKey: string }) => ({ status: 200, ok: true, data: req.providerConfigKey, headers: new Headers() })),
    getConnection: vi.fn(async (_id: string, key: string) => ({ id: "c", providerConfigKey: key, provider: "x", connectionConfig: {}, createdAt: null })),
    deleteConnection: vi.fn(async () => true),
    publicUrl: "https://nango.test",
    ...overrides,
  } as unknown as NangoClient;
}

describe("own OAuth app keys", () => {
  it("builds and splits <key>--<workspace hex> and keeps shared keys intact", () => {
    const key = ownIntegrationKey("google-drive", WS);
    expect(key).toBe("google-drive--3f2b1c4d5e6f4a7b8c9d0e1f2a3b4c5d");
    expect(key.length).toBeLessThanOrEqual(100);
    expect(splitIntegrationKey(key)).toEqual({ connectorKey: "google-drive", workspaceHex: "3f2b1c4d5e6f4a7b8c9d0e1f2a3b4c5d" });
    expect(splitIntegrationKey("google-drive")).toEqual({ connectorKey: "google-drive", workspaceHex: null });
    // a provider key that happens to contain "--" but no hex tail is not an own key
    expect(splitIntegrationKey("weird--thing")).toEqual({ connectorKey: "weird--thing", workspaceHex: null });
    expect(workspaceMatchesHex(WS, "3f2b1c4d5e6f4a7b8c9d0e1f2a3b4c5d")).toBe(true);
    expect(workspaceMatchesHex("00000000-0000-4000-8000-000000000000", "3f2b1c4d5e6f4a7b8c9d0e1f2a3b4c5d")).toBe(false);
    expect(workspaceMatchesHex(WS, null)).toBe(true);
  });

  it("reads the install's key and app kind, defaulting older installs to the shared app", () => {
    expect(installIntegrationKey({}, "jira")).toBe("jira");
    expect(installIntegrationKey({ nango_integration_key: "jira--abc" }, "jira")).toBe("jira--abc");
    expect(installOAuthAppKind({})).toBe("shared");
    expect(installOAuthAppKind({ oauth_app: "own" })).toBe("own");
  });
});

describe("upsertOwnOAuthApp", () => {
  const input = {
    connectorKey: "hubspot",
    nangoProvider: "hubspot",
    displayName: "HubSpot",
    workspaceId: WS,
    clientId: "cid",
    clientSecret: "shh",
  };

  it("creates the per-workspace integration with the default scopes", async () => {
    const c = fakeClient();
    const key = await upsertOwnOAuthApp(c, input);
    expect(key).toBe(ownIntegrationKey("hubspot", WS));
    expect(c.createIntegration).toHaveBeenCalledWith({
      uniqueKey: key,
      provider: "hubspot",
      displayName: "HubSpot (own app)",
      credentials: {
        type: "OAUTH2",
        client_id: "cid",
        client_secret: "shh",
        scopes: "crm.objects.deals.read,crm.objects.contacts.read,crm.objects.companies.read",
      },
    });
    expect(c.updateIntegration).not.toHaveBeenCalled();
  });

  it("replaces credentials when the integration exists, honouring custom scopes and OAuth1", async () => {
    const c = fakeClient({
      getIntegration: vi.fn(async () => ({ uniqueKey: "trello--x", provider: "trello", displayName: null, credentials: null })),
    });
    await upsertOwnOAuthApp(c, { ...input, connectorKey: "trello", nangoProvider: "trello", scopes: ["read", "write"] });
    expect(c.createIntegration).not.toHaveBeenCalled();
    expect(c.updateIntegration).toHaveBeenCalledWith(ownIntegrationKey("trello", WS), {
      credentials: { type: "OAUTH1", client_id: "cid", client_secret: "shh", scopes: "read,write" },
    });
  });

  it("falls back to update when a concurrent create won the race", async () => {
    const c = fakeClient({
      createIntegration: vi.fn(async () => {
        throw new NangoError("http_error", "nango 409: exists", 409);
      }),
    });
    await upsertOwnOAuthApp(c, input);
    expect(c.updateIntegration).toHaveBeenCalledTimes(1);
  });

  it("deletes the own integration by its key", async () => {
    const c = fakeClient();
    await deleteOwnOAuthApp(c, "hubspot", WS);
    expect(c.deleteIntegration).toHaveBeenCalledWith(ownIntegrationKey("hubspot", WS));
  });
});

describe("withIntegrationKey", () => {
  it("rewrites providerConfigKey on proxy and connection calls, delegates the rest", async () => {
    const c = fakeClient();
    const w = withIntegrationKey(c, "hubspot--abc");
    const res = await w.proxy({ method: "GET", providerConfigKey: "hubspot", connectionId: "conn", path: "/x" });
    expect(res.data).toBe("hubspot--abc");
    expect((c.proxy as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({ providerConfigKey: "hubspot--abc", path: "/x" });
    const conn = await w.getConnection("conn", "hubspot");
    expect(conn?.providerConfigKey).toBe("hubspot--abc");
    await w.deleteConnection("conn", "hubspot");
    expect(c.deleteConnection).toHaveBeenCalledWith("conn", "hubspot--abc");
    expect(w.publicUrl).toBe("https://nango.test");
  });
});
