import { afterEach, describe, expect, it, vi } from "vitest";
import { NANGO_PLACEHOLDER_CREDENTIAL } from "@/lib/nango/client";
import { _resetSetupCache } from "@/lib/nango/setup";

const listIntegrationsWithCredentials = vi.fn(async () => [] as Array<Record<string, unknown>>);
vi.mock("@/lib/nango/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/nango/client")>();
  return {
    ...actual,
    isNangoConfigured: () => true,
    nangoClient: () => ({ listIntegrationsWithCredentials }),
  };
});

import { GET } from "./route";

afterEach(() => _resetSetupCache());

describe("GET /api/integrations/catalog", () => {
  it("returns the marketplace, most popular first", async () => {
    const res = await GET(new Request("http://localhost/api/integrations/catalog"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ key: string; popularity: number; via: string; status: string }> };
    expect(body.entries[0]?.key).toBe("slack");
    expect(body.entries.some((e) => e.key === "jira" && e.via === "nango" && e.status === "available")).toBe(true);
    for (let i = 1; i < body.entries.length; i++) {
      expect(body.entries[i]!.popularity).toBeGreaterThan(body.entries[i - 1]!.popularity);
    }
  });

  it("filters by category and rejects unknown ones", async () => {
    const ok = await GET(new Request("http://localhost/api/integrations/catalog?category=support"));
    const body = (await ok.json()) as { entries: Array<{ category: string }> };
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.entries.every((e) => e.category === "support")).toBe(true);
    const bad = await GET(new Request("http://localhost/api/integrations/catalog?category=nope"));
    expect(bad.status).toBe(400);
  });

  it("marks Nango entries whose OAuth app is still a placeholder", async () => {
    listIntegrationsWithCredentials.mockResolvedValueOnce([
      { uniqueKey: "jira", provider: "jira-basic", displayName: null, credentials: null },
      { uniqueKey: "asana", provider: "asana", displayName: null, credentials: { type: "OAUTH2", clientId: NANGO_PLACEHOLDER_CREDENTIAL, scopes: "default" } },
    ]);
    const res = await GET(new Request("http://localhost/api/integrations/catalog"));
    const body = (await res.json()) as { entries: Array<{ key: string; via: string; status: string; setup?: string }> };
    const jira = body.entries.find((e) => e.key === "jira");
    expect(jira?.setup).toBe("ready");
    const asana = body.entries.find((e) => e.key === "asana");
    if (asana?.status === "available") expect(asana.setup).toBe("needs_oauth_app");
    else expect(asana?.setup).toBeUndefined();
    expect(body.entries.find((e) => e.key === "slack")?.setup).toBeUndefined();
  });

  it("omits setup when Nango is unreachable", async () => {
    listIntegrationsWithCredentials.mockRejectedValueOnce(new Error("down"));
    const res = await GET(new Request("http://localhost/api/integrations/catalog"));
    const body = (await res.json()) as { entries: Array<{ key: string; setup?: string }> };
    expect(body.entries.every((e) => e.setup === undefined)).toBe(true);
  });
});
