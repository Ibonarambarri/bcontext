import { describe, expect, it } from "vitest";
import { NANGO_PLACEHOLDER_CREDENTIAL, NangoClient, NangoError, readNangoConfig } from "./client";

function fakeFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

const config = { serverUrl: "https://nango.test", secretKey: "sk_test" };

describe("NangoClient", () => {
  it("creates a Connect session scoped to the workspace and integration", async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      new Response(JSON.stringify({ data: { token: "tok", connect_link: "https://nango.test/connect?x", expires_at: "2026-09-08T10:00:00Z" } }), {
        status: 201,
      }),
    );
    const client = new NangoClient(config, fetchImpl);
    const session = await client.createConnectSession({ workspaceId: "ws-1", allowedIntegrations: ["jira"] });
    expect(session).toEqual({ token: "tok", connectLink: "https://nango.test/connect?x", expiresAt: "2026-09-08T10:00:00Z" });
    expect(calls[0]?.url).toBe("https://nango.test/connect/sessions");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk_test");
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.allowed_integrations).toEqual(["jira"]);
    expect(body.tags.end_user_id).toBe("ws-1");
  });

  it("proxies with the connection headers and forwards query params", async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      new Response(JSON.stringify({ issues: [] }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const client = new NangoClient(config, fetchImpl);
    const res = await client.proxy<{ issues: unknown[] }>({
      method: "GET",
      providerConfigKey: "jira",
      connectionId: "conn-1",
      path: "rest/api/3/search/jql",
      query: { jql: 'updated >= "2026/09/01 00:00"', maxResults: 50, skip: undefined },
      headers: { "X-Custom": "1" },
    });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ issues: [] });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/proxy/rest/api/3/search/jql");
    expect(url.searchParams.get("maxResults")).toBe("50");
    expect(url.searchParams.has("skip")).toBe(false);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["Connection-Id"]).toBe("conn-1");
    expect(headers["Provider-Config-Key"]).toBe("jira");
    expect(headers["nango-proxy-X-Custom"]).toBe("1");
  });

  it("returns null for a missing connection and surfaces HTTP errors", async () => {
    const { fetchImpl } = fakeFetch((url) =>
      url.includes("/connections/missing") ? new Response("", { status: 404 }) : new Response("boom", { status: 500 }),
    );
    const client = new NangoClient(config, fetchImpl);
    expect(await client.getConnection("missing", "jira")).toBeNull();
    await expect(client.listIntegrations()).rejects.toBeInstanceOf(NangoError);
  });

  it("reads config from env and strips trailing slashes", () => {
    expect(readNangoConfig({ NANGO_SERVER_URL: "https://n.test/", NANGO_SECRET_KEY: "k" })).toEqual({
      serverUrl: "https://n.test",
      secretKey: "k",
      publicUrl: "https://n.test",
    });
    expect(readNangoConfig({ NANGO_SERVER_URL: "https://n.test" })).toBeNull();
  });

  it("lists integrations with credential metadata and creates one with placeholder OAuth credentials", async () => {
    const { fetchImpl, calls } = fakeFetch((url, init) => {
      if (init?.method === "POST") return new Response(JSON.stringify({ data: { unique_key: "asana", provider: "asana" } }), { status: 201 });
      if (url.endsWith("/integrations")) {
        return new Response(JSON.stringify({ data: [{ unique_key: "jira", provider: "jira-basic" }, { unique_key: "asana", provider: "asana" }] }), { status: 200 });
      }
      if (url.includes("/integrations/jira?include=credentials")) {
        return new Response(JSON.stringify({ data: { unique_key: "jira", provider: "jira-basic", credentials: null } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ data: { unique_key: "asana", provider: "asana", credentials: { type: "OAUTH2", client_id: NANGO_PLACEHOLDER_CREDENTIAL, client_secret: "x", scopes: "default" } } }),
        { status: 200 },
      );
    });
    const client = new NangoClient(config, fetchImpl);
    const rows = await client.listIntegrationsWithCredentials();
    expect(calls.map((c) => c.url)).toEqual([
      "https://nango.test/integrations",
      "https://nango.test/integrations/jira?include=credentials",
      "https://nango.test/integrations/asana?include=credentials",
    ]);
    expect(rows).toEqual([
      { uniqueKey: "jira", provider: "jira-basic", displayName: null, credentials: null },
      { uniqueKey: "asana", provider: "asana", displayName: null, credentials: { type: "OAUTH2", clientId: NANGO_PLACEHOLDER_CREDENTIAL, scopes: "default" } },
    ]);
    const created = await client.createIntegration({
      uniqueKey: "asana",
      provider: "asana",
      credentials: { type: "OAUTH2", client_id: NANGO_PLACEHOLDER_CREDENTIAL, client_secret: NANGO_PLACEHOLDER_CREDENTIAL, scopes: "default" },
    });
    expect(created.uniqueKey).toBe("asana");
    const body = JSON.parse(String(calls[3]?.init?.body));
    expect(body.credentials.client_id).toBe(NANGO_PLACEHOLDER_CREDENTIAL);
  });
});
