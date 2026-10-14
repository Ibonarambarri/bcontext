import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/bcontext search` runs on behalf of the install, not of anyone in the
 * channel. These tests pin the three answers the webhook can give: the
 * install's own grant, the explicit system fallback for an install with no
 * principal yet, and a refusal when the grant was revoked. And, whatever the
 * answer, the reply never hints at content the channel cannot see.
 */
const WS = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const INSTALL = { id: "inst-1", workspace_id: WS, config: { team_id: "T1" }, secret_ref: null, workspaces: { slug: "acme" } };

vi.mock("@/lib/connectors/bootstrap", () => ({}));
vi.mock("@/lib/connectors/registry", () => ({
  registerConnector: vi.fn(),
  getConnectorOrNull: (id: string) => (id === "slack" ? { id, handleWebhook: vi.fn() } : null),
}));
vi.mock("@/lib/connectors/slack", () => ({ verifySlackSignature: async () => true }));
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "filter"]) b[m] = () => b;
      b.maybeSingle = async () => ({ data: INSTALL, error: null });
      return b;
    },
  }),
}));
const retrieveScoped = vi.fn();
vi.mock("@/lib/rag", () => ({
  retrieveScoped: (...a: unknown[]) => retrieveScoped(...a),
  resolveEmbeddingModel: () => "embed-test",
}));
const inner = { workspace: { id: WS }, backend: "supabase" };
vi.mock("@/lib/storage", () => ({ getStorageById: async () => inner }));
const scopedStorage = vi.fn((storage: unknown, grant: unknown) => ({ storage, grant }));
vi.mock("@/lib/storage/scoped", () => ({ scopedStorage: (...a: unknown[]) => scopedStorage(...(a as [unknown, unknown])) }));
const resolveInstallGrant = vi.fn();
vi.mock("@/lib/auth/install-principal", () => ({
  resolveInstallGrant: (...a: unknown[]) => resolveInstallGrant(...a),
}));
vi.mock("@bcontext-dev/contract/log", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { log } from "@bcontext-dev/contract/log";
import type { Grant } from "@/lib/auth/grants";
import { POST } from "./route";

const botGrant: Grant = {
  workspaceId: WS,
  principal: { kind: "service_account", id: "cp-1" },
  verbs: ["read"],
  reach: { type: "query", query: { schema_version: 1, tags_any: ["finanzas"] } as never },
};

function search(query: string) {
  const body = new URLSearchParams({ team_id: "T1", command: "/bcontext", text: `search ${query}` });
  return POST(
    new Request("http://localhost/api/webhooks/slack", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }),
  );
}

async function reply(res: Response): Promise<string> {
  expect(res.status).toBe(200);
  return ((await res.json()) as { text: string }).text;
}

beforeEach(() => {
  process.env.SLACK_SIGNING_SECRET = "test-secret";
  retrieveScoped.mockResolvedValue({ hits: [{ title: "Q3 budget", content: "Numbers." }] });
});

afterEach(() => {
  resolveInstallGrant.mockReset();
  retrieveScoped.mockReset();
  scopedStorage.mockClear();
  vi.clearAllMocks();
});

describe("POST /api/webhooks/slack — /bcontext search", () => {
  it("searches under the install's own grant", async () => {
    resolveInstallGrant.mockResolvedValue({ principalId: "cp-1", grant: botGrant });
    const text = await reply(await search("budget"));
    expect(resolveInstallGrant).toHaveBeenCalledWith(WS, "inst-1");
    expect(scopedStorage).toHaveBeenCalledWith(inner, botGrant);
    expect(text).toContain("Q3 budget");
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("falls back to an explicit system grant, with a warning, for an install that has no principal yet", async () => {
    resolveInstallGrant.mockResolvedValue(null);
    await reply(await search("budget"));
    const grant = scopedStorage.mock.calls[0]?.[1] as Grant;
    expect(grant.principal.kind).toBe("system");
    expect(grant.reach).toEqual({ type: "all" });
    expect(log.warn).toHaveBeenCalledWith("slack.search.unscoped_install", expect.objectContaining({ install_id: "inst-1" }));
  });

  it("refuses when the install's grant is revoked, without searching", async () => {
    resolveInstallGrant.mockResolvedValue({ principalId: "cp-1", grant: { denied: "not_found" } });
    const text = await reply(await search("budget"));
    expect(retrieveScoped).not.toHaveBeenCalled();
    expect(text).toMatch(/turned off/);
  });

  it("never hints at content outside the bot's reach", async () => {
    resolveInstallGrant.mockResolvedValue({ principalId: "cp-1", grant: botGrant });
    retrieveScoped.mockResolvedValue({ hits: [] });
    const text = await reply(await search("salaries"));
    expect(text).toBe("_no results_");
    // A narrowed reach is invisible from the channel: no counts of what was
    // withheld, no mention that the search was scoped.
    for (const forbidden of [/hidden/i, /outside/i, /reach/i, /more result/i, /narrow/i, /restricted/i]) {
      expect(text).not.toMatch(forbidden);
    }
  });
});
