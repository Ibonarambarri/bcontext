import { afterEach, describe, expect, it, vi } from "vitest";

// The catalog only carries `oauth_setup` when the instance names its Nango;
// it is built at import, so the env has to be there first.
vi.hoisted(() => {
  process.env.NANGO_PUBLIC_URL ??= "https://nango.test";
});

vi.mock("@/lib/auth/require", () => ({
  gate: vi.fn(async () => ({ kind: "user", userId: "u1" })),
}));
const upsertInstall = vi.fn(async (input: { workspaceId: string; connectorId: string; config?: Record<string, unknown> }) => ({
  id: "inst-1",
  workspace_id: input.workspaceId,
  connector_id: input.connectorId,
  config: input.config ?? {},
  secret_ref: null,
  status: "pending",
  last_sync_at: null,
  last_error: null,
  created_at: "",
  updated_at: "",
}));
vi.mock("@/lib/connectors/installs", () => ({
  upsertInstall: (...a: unknown[]) => upsertInstall(...(a as [Parameters<typeof upsertInstall>[0]])),
}));
const authorize = vi.fn();
vi.mock("@/lib/connectors/registry", () => ({
  registerConnector: vi.fn(),
  getConnectorOrNull: (id: string) =>
    id === "hubspot" || id === "airtable" || id === "slack" ? { id, authorize } : null,
}));
vi.mock("@/lib/connectors/bootstrap", () => ({}));
const ensureInstallPrincipal = vi.fn();
vi.mock("@/lib/auth/install-principal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/install-principal")>()),
  ensureInstallPrincipal: (...a: unknown[]) => ensureInstallPrincipal(...a),
}));

import { NangoOAuthAppRequiredError } from "@/lib/connectors/nango";
import { POST } from "./route";

const WS = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

function post(id: string, body: unknown) {
  return POST(
    new Request(`http://localhost/api/connectors/${id}/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

afterEach(() => {
  authorize.mockReset();
  upsertInstall.mockClear();
  ensureInstallPrincipal.mockReset();
});

describe("POST /api/connectors/slack/install (the bot as a principal)", () => {
  it("gives the install its own principal and says what it can see by default", async () => {
    authorize.mockResolvedValue({ redirectUrl: "https://slack.com/oauth/v2/authorize?x" });
    ensureInstallPrincipal.mockResolvedValue({
      principal: { kind: "service_account", id: "cp-1" },
      reach: "all",
      note: "By default the Slack bot can search everything in this workspace.",
    });
    const res = await post("slack", { workspace_id: WS });
    expect(res.status).toBe(200);
    expect(ensureInstallPrincipal).toHaveBeenCalledWith({ workspaceId: WS, installId: "inst-1", displayName: "Slack bot" });
    const body = (await res.json()) as { access: { principal: { kind: string }; reach: string; note: string } };
    expect(body.access.principal.kind).toBe("service_account");
    expect(body.access.reach).toBe("all");
    expect(body.access.note).toMatch(/everything/);
  });

  it("still installs, and says the bot is unscoped, when the principal cannot be written", async () => {
    authorize.mockResolvedValue({ redirectUrl: "https://slack.com/oauth/v2/authorize?x" });
    ensureInstallPrincipal.mockResolvedValue(null);
    const res = await post("slack", { workspace_id: WS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { install_id: string; access: { principal: null; reach: string } };
    expect(body.install_id).toBe("inst-1");
    expect(body.access).toMatchObject({ principal: null, reach: "unscoped" });
  });

  it("gives no principal to a connector that ingests as the system", async () => {
    authorize.mockResolvedValue({ redirectUrl: "https://nango.test/connect/abc", sessionToken: "tok" });
    const res = await post("hubspot", { workspace_id: WS });
    expect(ensureInstallPrincipal).not.toHaveBeenCalled();
    expect(await res.json()).not.toHaveProperty("access");
  });
});

describe("POST /api/connectors/:id/install (hybrid OAuth)", () => {
  it("returns the Connect session when the shared app is ready", async () => {
    authorize.mockResolvedValue({ redirectUrl: "https://nango.test/connect/abc", sessionToken: "tok" });
    const res = await post("hubspot", { workspace_id: WS });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      install_id: "inst-1",
      redirect_url: "https://nango.test/connect/abc",
      connect: { session_token: "tok", connect_url: "https://nango.test/connect/abc" },
    });
    expect(authorize.mock.calls[0]?.[2]).toBeUndefined();
  });

  it("hands the workspace's own app to the connector and never echoes the secret", async () => {
    authorize.mockResolvedValue({ redirectUrl: "https://nango.test/connect/own", sessionToken: "tok2" });
    const res = await post("hubspot", { workspace_id: WS, oauth_app: { client_id: "cid", client_secret: "shh", scopes: ["a"] } });
    expect(res.status).toBe(200);
    expect(authorize.mock.calls[0]?.[2]).toEqual({ oauth_app: { client_id: "cid", client_secret: "shh", scopes: ["a"] } });
    expect(JSON.stringify(await res.json())).not.toContain("shh");
  });

  it("answers 409 needs_oauth_app with the setup block when neither app exists", async () => {
    authorize.mockRejectedValue(new NangoOAuthAppRequiredError("hubspot"));
    const res = await post("hubspot", { workspace_id: WS });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; oauth_setup: { callback_url: string; scopes: string[]; auth_mode: string } };
    expect(body.error).toBe("needs_oauth_app");
    expect(body.oauth_setup.callback_url).toMatch(/\/oauth\/callback$/);
    expect(body.oauth_setup.scopes.length).toBeGreaterThan(0);
    expect(body.oauth_setup.auth_mode).toBe("oauth2");
  });

  it("refuses an own app on a non-OAuth provider and hides invalid bodies", async () => {
    const notOauth = await post("airtable", { workspace_id: WS, oauth_app: { client_id: "cid", client_secret: "shh" } });
    expect(notOauth.status).toBe(409);
    expect(await notOauth.json()).toEqual({ error: "not_oauth" });
    const bad = await post("hubspot", { workspace_id: WS, oauth_app: { client_id: "", client_secret: "top-secret" } });
    expect(bad.status).toBe(400);
    const text = JSON.stringify(await bad.json());
    expect(text).not.toContain("top-secret");
    expect(text).toContain("oauth_app");
  });
});
