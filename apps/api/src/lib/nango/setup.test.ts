import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NangoClient } from "./client";
import { NANGO_PLACEHOLDER_CREDENTIAL } from "./client";
import { _resetSetupCache, integrationSetupMap, setupFromCredentials } from "./setup";

function client(rows: Array<{ uniqueKey: string; clientId?: string | null }>) {
  const listIntegrationsWithCredentials = vi.fn(async () =>
    rows.map((r) => ({
      uniqueKey: r.uniqueKey,
      provider: "x",
      displayName: null,
      credentials: r.clientId === undefined ? null : { type: "OAUTH2", clientId: r.clientId, scopes: null },
    })),
  );
  return { fn: listIntegrationsWithCredentials, client: () => ({ listIntegrationsWithCredentials }) as unknown as NangoClient };
}

describe("integration setup map", () => {
  beforeEach(() => _resetSetupCache());

  it("flags placeholder OAuth credentials and treats everything else as ready", async () => {
    expect(setupFromCredentials(NANGO_PLACEHOLDER_CREDENTIAL)).toBe("needs_oauth_app");
    expect(setupFromCredentials("real-client-id")).toBe("ready");
    expect(setupFromCredentials(null)).toBe("ready");
    const { client: c } = client([
      { uniqueKey: "asana", clientId: NANGO_PLACEHOLDER_CREDENTIAL },
      { uniqueKey: "hubspot", clientId: "abc" },
      { uniqueKey: "jira" },
    ]);
    const map = await integrationSetupMap({ client: c });
    expect(map.get("asana")).toBe("needs_oauth_app");
    expect(map.get("hubspot")).toBe("ready");
    expect(map.get("jira")).toBe("ready");
  });

  it("caches for a minute and degrades to an empty map on failure", async () => {
    let t = 1_000_000;
    const { client: c, fn } = client([{ uniqueKey: "asana", clientId: NANGO_PLACEHOLDER_CREDENTIAL }]);
    await integrationSetupMap({ client: c, now: () => t });
    t += 30_000;
    await integrationSetupMap({ client: c, now: () => t });
    expect(fn).toHaveBeenCalledTimes(1);
    t += 31_000;
    await integrationSetupMap({ client: c, now: () => t });
    expect(fn).toHaveBeenCalledTimes(2);

    _resetSetupCache();
    const failing = () => ({ listIntegrationsWithCredentials: async () => { throw new Error("down"); } }) as unknown as NangoClient;
    expect((await integrationSetupMap({ client: failing })).size).toBe(0);
  });
});
