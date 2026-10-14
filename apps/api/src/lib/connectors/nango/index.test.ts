import { afterEach, describe, expect, it, vi } from "vitest";

const installs = new Map<string, { id: string; workspace_id: string; connector_id: string; config: Record<string, unknown>; status: string }>();
const updateInstall = vi.fn(async (id: string, patch: Record<string, unknown>) => {
  const row = installs.get(id);
  if (row) Object.assign(row, patch);
});
vi.mock("../installs", () => ({
  updateInstall: (...a: unknown[]) => updateInstall(...(a as [string, Record<string, unknown>])),
  getInstallById: async (id: string) => installs.get(id) ?? null,
}));

const extractBatch = vi.fn();
vi.mock("@/lib/ingest/batch-extract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ingest/batch-extract")>();
  return { ...actual, extractBatch: (...a: unknown[]) => extractBatch(...(a as [])) };
});
const proposeCandidate = vi.fn(async (input: Record<string, unknown>) => ({ id: "cand-1", status: "pending", workspace_id: input.workspaceId, ...input }));
vi.mock("@/lib/ingest/candidates", () => ({ proposeCandidate: (...a: unknown[]) => proposeCandidate(...(a as [Record<string, unknown>])) }));
const triageCandidate = vi.fn();
vi.mock("@/lib/nexo/triage", () => ({ triageCandidate: (...a: unknown[]) => triageCandidate(...(a as [])) }));

import { ConnectorAuthError } from "@bcontext-dev/contract/connectors/types";
import { ExtractCandidateError } from "@/lib/ingest/extract";
import type { NangoClient } from "@/lib/nango/client";
import { NangoOAuthAppRequiredError, ingestSignals, nangoConnector, sinceFor } from "./index";
import type { NangoAdapter } from "./adapters/shared";

const fetchChanges = vi.fn();
const adapter: NangoAdapter = { id: "jira", provider: "jira-basic", sourceHint: "jira:issues", fetchChanges };
/** An OAuth catalog entry (hubspot is `auth: "oauth2"` in the catalog). */
const oauthAdapter: NangoAdapter = { id: "hubspot", provider: "hubspot", sourceHint: "hubspot:crm", fetchChanges };
const WS = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const OWN_KEY = "hubspot--3f2b1c4d5e6f4a7b8c9d0e1f2a3b4c5d";

function client(overrides: Partial<Record<keyof NangoClient, unknown>> = {}) {
  return {
    publicUrl: "https://nango.test",
    createConnectSession: vi.fn(async () => ({ token: "tok", connectLink: "https://nango.test/connect/abc", expiresAt: null })),
    getConnection: vi.fn(async () => ({ id: "conn-1", providerConfigKey: "jira", provider: "jira-basic", connectionConfig: { subdomain: "acme" }, createdAt: null })),
    deleteConnection: vi.fn(async () => true),
    getIntegration: vi.fn(async () => null),
    createIntegration: vi.fn(async (i: { uniqueKey: string }) => ({ uniqueKey: i.uniqueKey, provider: "hubspot", displayName: null })),
    updateIntegration: vi.fn(async (k: string) => ({ uniqueKey: k, provider: "hubspot", displayName: null })),
    deleteIntegration: vi.fn(async () => true),
    proxy: vi.fn(async (req: { providerConfigKey: string }) => ({ status: 200, ok: true, data: req.providerConfigKey, headers: new Headers() })),
    ...overrides,
  } as unknown as NangoClient;
}

const ctx = (config: Record<string, unknown> = {}) => ({ workspaceId: "ws-1", installId: "inst-1", config, secret: null });

afterEach(() => {
  installs.clear();
  updateInstall.mockClear();
  extractBatch.mockReset();
  proposeCandidate.mockClear();
  triageCandidate.mockReset();
  fetchChanges.mockReset();
});

describe("sinceFor", () => {
  it("prefers the explicit cursor, then last_cursor, then a 7-day lookback", () => {
    const now = new Date("2026-09-08T12:00:00Z");
    expect(sinceFor({ last_cursor: "2026-09-07T00:00:00Z" }, "2026-09-07T06:00:00Z", now).toISOString()).toBe("2026-09-07T06:00:00.000Z");
    expect(sinceFor({ last_cursor: "2026-09-07T00:00:00Z" }, null, now).toISOString()).toBe("2026-09-07T00:00:00.000Z");
    expect(sinceFor({}, null, now).toISOString()).toBe("2026-09-01T12:00:00.000Z");
  });
});

describe("ingestSignals", () => {
  it("folds signals into candidates, proposes each with evidence and lets NEXO triage", async () => {
    extractBatch.mockResolvedValue({
      model: "m",
      skipped: 1,
      candidates: [{ kind: "decision", title: "Use Postgres", contentMd: "## Decision", confidence: 0.9, evidence: [{ external_id: "issue:1", excerpt: "we go with postgres" }] }],
    });
    triageCandidate.mockResolvedValue({ kind: "accepted", nodeId: "n1" });
    const summary = await ingestSignals({
      workspaceId: "ws-1",
      connectorId: "jira",
      installId: "inst-1",
      sourceHint: "jira:issues",
      guidance: "decisions only",
      signals: [{ external_id: "issue:1", title: "DB", text: "we go with postgres", url: "https://x/1", at: "2026-09-02T00:00:00Z" }],
    });
    expect(summary).toEqual({ signals: 1, candidates: 1, accepted: 1, conflicts: 0, skipped: 1 });
    const proposed = proposeCandidate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(proposed.source).toBe("jira");
    expect(String(proposed.externalId)).toMatch(/^batch:decision:/);
    expect((proposed.provenance as { evidence: Array<{ url: string }> }).evidence[0]?.url).toBe("https://x/1");
    expect(triageCandidate).toHaveBeenCalledTimes(1);
  });

  it("is a no-op without an AI gateway key", async () => {
    extractBatch.mockRejectedValue(new ExtractCandidateError("no_gateway_key"));
    const summary = await ingestSignals({ workspaceId: "ws-1", connectorId: "jira", installId: "inst-1", sourceHint: "x", guidance: null, signals: [{ external_id: "a", title: "A", text: "x" }] });
    expect(summary.candidates).toBe(0);
    expect(proposeCandidate).not.toHaveBeenCalled();
  });
});

describe("nangoConnector", () => {
  it("starts a Connect session and marks the install as Nango-backed", async () => {
    installs.set("inst-1", { id: "inst-1", workspace_id: "ws-1", connector_id: "jira", config: {}, status: "pending" });
    const c = client();
    const out = (await nangoConnector(adapter, { client: () => c }).authorize(ctx(), "start")) as { redirectUrl: string; sessionToken: string };
    expect(out.sessionToken).toBe("tok");
    expect(out.redirectUrl).toBe("https://nango.test/connect/abc");
    expect(installs.get("inst-1")?.config).toMatchObject({ provider: "nango", nango_provider: "jira-basic" });
  });

  it("hybrid OAuth: shared app when Bcontext has one, else the workspace must bring its own", async () => {
    const wsCtx = { workspaceId: WS, installId: "inst-1", config: {}, secret: null };
    // shared app ready → shared key
    installs.set("inst-1", { id: "inst-1", workspace_id: WS, connector_id: "hubspot", config: {}, status: "pending" });
    const ready = client({
      getIntegration: vi.fn(async () => ({ uniqueKey: "hubspot", provider: "hubspot", displayName: null, credentials: { type: "OAUTH2", clientId: "real", scopes: null } })),
    });
    await nangoConnector(oauthAdapter, { client: () => ready }).authorize(wsCtx, "start");
    expect(ready.createConnectSession).toHaveBeenCalledWith(expect.objectContaining({ allowedIntegrations: ["hubspot"] }));
    expect(installs.get("inst-1")?.config).toMatchObject({ nango_integration_key: "hubspot", oauth_app: "shared" });
    expect(ready.createIntegration).not.toHaveBeenCalled();

    // placeholder credentials and no own app → 409 material
    const placeholder = client({
      getIntegration: vi.fn(async () => ({ uniqueKey: "hubspot", provider: "hubspot", displayName: null, credentials: { type: "OAUTH2", clientId: "pending-owner-setup", scopes: null } })),
    });
    await expect(nangoConnector(oauthAdapter, { client: () => placeholder }).authorize(wsCtx, "start")).rejects.toBeInstanceOf(NangoOAuthAppRequiredError);
    expect(placeholder.createConnectSession).not.toHaveBeenCalled();

    // own app → per-workspace integration, session bound to it
    const own = client();
    const out = (await nangoConnector(oauthAdapter, { client: () => own }).authorize(wsCtx, "start", {
      oauth_app: { client_id: "cid", client_secret: "shh", scopes: ["crm.objects.deals.read"] },
    })) as { sessionToken: string };
    expect(out.sessionToken).toBe("tok");
    expect(own.createIntegration).toHaveBeenCalledWith(expect.objectContaining({
      uniqueKey: OWN_KEY,
      provider: "hubspot",
      credentials: { type: "OAUTH2", client_id: "cid", client_secret: "shh", scopes: "crm.objects.deals.read" },
    }));
    expect(own.createConnectSession).toHaveBeenCalledWith(expect.objectContaining({ allowedIntegrations: [OWN_KEY] }));
    expect(installs.get("inst-1")?.config).toMatchObject({ nango_integration_key: OWN_KEY, oauth_app: "own" });

    // non-OAuth providers never consult the shared app
    const basic = client();
    await nangoConnector(adapter, { client: () => basic }).authorize(ctx(), "start", { oauth_app: { client_id: "x", client_secret: "y" } });
    expect(basic.getIntegration).not.toHaveBeenCalled();
    expect(basic.createIntegration).not.toHaveBeenCalled();
    expect(installs.get("inst-1")?.config).toMatchObject({ nango_integration_key: "jira", oauth_app: "shared" });
  });

  it("uses the install's integration key to complete, revoke and proxy, and drops the own app on revoke", async () => {
    installs.set("inst-1", { id: "inst-1", workspace_id: WS, connector_id: "hubspot", config: { provider: "nango", nango_integration_key: OWN_KEY, oauth_app: "own" }, status: "pending" });
    const c = client();
    const own = nangoConnector(oauthAdapter, { client: () => c });
    await own.authorize({ workspaceId: WS, installId: "inst-1", config: { provider: "nango", nango_integration_key: OWN_KEY, oauth_app: "own" }, secret: null }, "complete", { connection_id: "conn-9" });
    expect(c.getConnection).toHaveBeenCalledWith("conn-9", OWN_KEY);

    fetchChanges.mockImplementation(async ({ client: k }: { client: NangoClient }) => {
      const res = await k.proxy({ method: "GET", providerConfigKey: "hubspot", connectionId: "conn-9", path: "/crm" });
      return { signals: [], stats: { routed_to: res.data as number } };
    });
    await own.fullSync({ workspaceId: WS, installId: "inst-1", config: { nango_connection_id: "conn-9", nango_integration_key: OWN_KEY, oauth_app: "own" }, secret: null }, null);
    expect((c.proxy as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({ providerConfigKey: OWN_KEY });
    expect(installs.get("inst-1")?.config).toMatchObject({ last_run_stats: expect.objectContaining({ routed_to: OWN_KEY }) });

    await own.authorize({ workspaceId: WS, installId: "inst-1", config: { nango_connection_id: "conn-9", nango_integration_key: OWN_KEY, oauth_app: "own" }, secret: null }, "revoke");
    expect(c.deleteConnection).toHaveBeenCalledWith("conn-9", OWN_KEY);
    expect(c.deleteIntegration).toHaveBeenCalledWith(OWN_KEY);

    // a shared install never deletes the shared integration
    const shared = client();
    await nangoConnector(oauthAdapter, { client: () => shared }).authorize({ workspaceId: WS, installId: "inst-1", config: { nango_connection_id: "conn-1" }, secret: null }, "revoke");
    expect(shared.deleteConnection).toHaveBeenCalledWith("conn-1", "hubspot");
    expect(shared.deleteIntegration).not.toHaveBeenCalled();
  });

  it("completes only when the connection exists in Nango", async () => {
    installs.set("inst-1", { id: "inst-1", workspace_id: "ws-1", connector_id: "jira", config: { provider: "nango" }, status: "pending" });
    const c = client();
    await nangoConnector(adapter, { client: () => c }).authorize(ctx({ provider: "nango" }), "complete", { connection_id: "conn-1" });
    expect(installs.get("inst-1")).toMatchObject({ status: "active", config: { nango_connection_id: "conn-1", nango_connection_config: { subdomain: "acme" } } });

    const missing = client({ getConnection: vi.fn(async () => null) });
    await expect(
      nangoConnector(adapter, { client: () => missing }).authorize(ctx(), "complete", { connection_id: "ghost" }),
    ).rejects.toBeInstanceOf(ConnectorAuthError);
  });

  it("revokes by deleting the Nango connection", async () => {
    const c = client();
    await nangoConnector(adapter, { client: () => c }).authorize(ctx({ nango_connection_id: "conn-1" }), "revoke");
    expect(c.deleteConnection).toHaveBeenCalledWith("conn-1", "jira");
  });

  it("fullSync fetches since the cursor, ingests, and stores cursor + stats", async () => {
    installs.set("inst-1", { id: "inst-1", workspace_id: "ws-1", connector_id: "jira", config: { nango_connection_id: "conn-1", last_cursor: "2026-09-07T00:00:00Z" }, status: "active" });
    fetchChanges.mockResolvedValue({ signals: [{ external_id: "issue:1", title: "A", text: "x" }], stats: { pages: 1 } });
    extractBatch.mockResolvedValue({ model: "m", skipped: 0, candidates: [] });
    const c = client();
    const out = await nangoConnector(adapter, { client: () => c }).fullSync(ctx({ nango_connection_id: "conn-1", last_cursor: "2026-09-07T00:00:00Z" }), null);
    expect(fetchChanges.mock.calls[0]?.[0]).toMatchObject({ connectionId: "conn-1", since: new Date("2026-09-07T00:00:00Z") });
    expect(out.processed).toBe(1);
    expect(out.nodes).toEqual([]);
    const config = installs.get("inst-1")?.config as Record<string, unknown>;
    expect(typeof config.last_cursor).toBe("string");
    expect(config.last_run_stats).toMatchObject({ signals: 1, candidates: 0, pages: 1 });
  });

  it("fullSync refuses to run before the connection exists", async () => {
    await expect(nangoConnector(adapter, { client }).fullSync(ctx({}), null)).rejects.toBeInstanceOf(ConnectorAuthError);
  });
});
