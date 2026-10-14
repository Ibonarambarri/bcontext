/**
 * BYOK keys: admins of the organization store, list and remove a provider
 * key; the key itself never comes back over HTTP. Everyone else gets the
 * gate's answer. Storage runs on the in-memory fallback (no Supabase).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ admin: true }));
vi.mock("@/lib/organizations/admin", () => ({
  gateOrgAdmin: async () =>
    state.admin
      ? { org: { id: "org-1", slug: "acme", name: "Acme", created_at: "" }, actor: { userId: "u-admin" }, role: "owner", via_platform_admin: false }
      : Response.json({ error: "not_found" }, { status: 404 }),
}));

import { resetOrgAiKeysForTests, resolveOrgAiKey } from "@/lib/nexos/org-ai-keys";
import { DELETE, GET, PUT } from "./route";

const headers = { "content-type": "application/json", origin: "http://localhost", host: "localhost" };
const req = (path: string, method = "GET", body?: unknown) =>
  new Request(`http://localhost${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

beforeEach(() => {
  state.admin = true;
  resetOrgAiKeysForTests();
});

describe("/api/org/ai-keys", () => {
  it("stores a key write-only and lists provider + last4", async () => {
    const put = await PUT(req("/api/org/ai-keys?org=acme", "PUT", { provider: "anthropic", api_key: "sk-ant-secret-1234" }));
    expect(put.status).toBe(200);
    const text = await put.text();
    expect(text).not.toContain("secret");
    expect(JSON.parse(text)).toMatchObject({ key: { provider: "anthropic", last4: "1234", created_by: "u-admin" } });

    const listed = await (await GET(req("/api/org/ai-keys?org=acme"))).json();
    expect(listed).toEqual({ keys: [expect.objectContaining({ provider: "anthropic", last4: "1234" })] });
    expect(JSON.stringify(listed)).not.toContain("sk-ant");
    expect(await resolveOrgAiKey("org-1")).toEqual({ provider: "anthropic", apiKey: "sk-ant-secret-1234" });
  });

  it("validates and deletes", async () => {
    expect((await PUT(req("/api/org/ai-keys?org=acme", "PUT", { provider: "mistral", api_key: "whatever-123" }))).status).toBe(400);
    expect((await DELETE(req("/api/org/ai-keys?org=acme&provider=nope", "DELETE"))).status).toBe(400);
    expect((await DELETE(req("/api/org/ai-keys?org=acme&provider=openai", "DELETE"))).status).toBe(404);
    await PUT(req("/api/org/ai-keys?org=acme", "PUT", { provider: "openai", api_key: "sk-openai-abcd" }));
    expect((await DELETE(req("/api/org/ai-keys?org=acme&provider=openai", "DELETE"))).status).toBe(200);
    expect(await resolveOrgAiKey("org-1")).toBeNull();
  });

  it("answers the gate's 404 to non-admins", async () => {
    state.admin = false;
    expect((await GET(req("/api/org/ai-keys?org=acme"))).status).toBe(404);
    expect((await PUT(req("/api/org/ai-keys?org=acme", "PUT", { provider: "openai", api_key: "sk-openai-abcd" }))).status).toBe(404);
  });
});
