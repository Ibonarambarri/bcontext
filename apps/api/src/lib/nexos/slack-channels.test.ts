/**
 * The channel picker's listing: bot token or Nango proxy, cursor pagination
 * up to the cap, the public-only retry when `groups:read` was not granted,
 * and the tenant / connector refusals.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectorInstall } from "@/lib/connectors/installs";
import { setSlackDepsForTests } from "./slack-api";
import { listSlackChannels, MAX_CHANNELS } from "./slack-channels";
import type { NexoTarget } from "./types";

const t: NexoTarget = { workspaceId: "ws-ch", backend: "supabase" };

function install(over: Partial<ConnectorInstall> = {}): ConnectorInstall {
  return {
    id: "inst-1",
    workspace_id: "ws-ch",
    connector_id: "slack",
    config: { team_id: "T1" },
    secret_ref: `inline:${Buffer.from("xoxb-test").toString("base64")}`,
    status: "active",
    last_sync_at: null,
    last_error: null,
    created_at: "",
    updated_at: "",
    ...over,
  };
}

afterEach(() => setSlackDepsForTests(null));

describe("listSlackChannels", () => {
  it("pages through conversations.list with the bot token, members first", async () => {
    const fetch = vi.fn(async (url: string) => {
      const cursor = new URL(url).searchParams.get("cursor");
      return Response.json(
        cursor
          ? { ok: true, channels: [{ id: "C3", name: "alpha", is_private: true, is_member: true }] }
          : { ok: true, channels: [{ id: "C1", name: "zeta", is_member: false }, { id: "C2", name: "beta", is_member: true }], response_metadata: { next_cursor: "next" } },
      );
    });
    setSlackDepsForTests({ fetch: fetch as unknown as typeof globalThis.fetch, getInstall: async () => install() });
    const out = await listSlackChannels(t, "inst-1");
    expect(out).toEqual({
      ok: true,
      truncated: false,
      channels: [
        { id: "C3", name: "alpha", is_private: true, is_member: true },
        { id: "C2", name: "beta", is_private: false, is_member: true },
        { id: "C1", name: "zeta", is_private: false, is_member: false },
      ],
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("https://slack.com/api/conversations.list?");
    expect(new URL(url).searchParams.get("types")).toBe("public_channel,private_channel");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer xoxb-test");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("stops at the cap and says so", async () => {
    let n = 0;
    const fetch = vi.fn(async () =>
      Response.json({
        ok: true,
        channels: Array.from({ length: 200 }, () => ({ id: `C${n++}`, name: `c${n}` })),
        response_metadata: { next_cursor: "more" },
      }),
    );
    setSlackDepsForTests({ fetch: fetch as unknown as typeof globalThis.fetch, getInstall: async () => install() });
    const out = await listSlackChannels(t, "inst-1");
    expect(out.ok && out.channels.length).toBe(MAX_CHANNELS);
    expect(out.ok && out.truncated).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(MAX_CHANNELS / 200);
  });

  it("falls back to public channels when groups:read is missing", async () => {
    const fetch = vi.fn(async (url: string) =>
      new URL(url).searchParams.get("types")!.includes("private")
        ? Response.json({ ok: false, error: "missing_scope" })
        : Response.json({ ok: true, channels: [{ id: "C1", name: "general", is_member: true }] }),
    );
    setSlackDepsForTests({ fetch: fetch as unknown as typeof globalThis.fetch, getInstall: async () => install() });
    const out = await listSlackChannels(t, "inst-1");
    expect(out).toMatchObject({ ok: true, channels: [{ id: "C1" }] });
  });

  it("goes through the Nango proxy for slack-nango", async () => {
    const proxy = vi.fn(async () => ({ ok: true, status: 200, data: { ok: true, channels: [{ id: "C9", name: "ops" }] }, headers: new Headers() }));
    setSlackDepsForTests({
      nango: (() => ({ proxy })) as never,
      getInstall: async () =>
        install({ connector_id: "slack-nango" as never, secret_ref: null, config: { provider: "nango", nango_connection_id: "conn-1", nango_integration_key: "slack-nango--ws" } }),
    });
    const out = await listSlackChannels(t, "inst-1");
    expect(out).toMatchObject({ ok: true, channels: [{ id: "C9", name: "ops" }] });
    expect(proxy).toHaveBeenCalledWith(expect.objectContaining({
      method: "GET",
      path: "/conversations.list",
      connectionId: "conn-1",
      providerConfigKey: "slack-nango--ws",
      query: expect.objectContaining({ types: "public_channel,private_channel", limit: "200" }),
    }));
  });

  it("refuses other tenants, uninstalled installs and other connectors; reports Slack errors", async () => {
    setSlackDepsForTests({ getInstall: async () => install({ workspace_id: "ws-else" }) });
    expect(await listSlackChannels(t, "inst-1")).toEqual({ ok: false, error: "install_not_found" });
    setSlackDepsForTests({ getInstall: async () => install({ status: "uninstalled" as never }) });
    expect(await listSlackChannels(t, "inst-1")).toEqual({ ok: false, error: "install_not_found" });
    setSlackDepsForTests({ getInstall: async () => install({ connector_id: "github" as never }) });
    expect(await listSlackChannels(t, "inst-1")).toEqual({ ok: false, error: "unsupported" });
    setSlackDepsForTests({
      fetch: (async () => Response.json({ ok: false, error: "invalid_auth" })) as unknown as typeof globalThis.fetch,
      getInstall: async () => install(),
    });
    expect(await listSlackChannels(t, "inst-1")).toEqual({ ok: false, error: "invalid_auth" });
    expect(await listSlackChannels({ workspaceId: "ws-ch", backend: "demo" }, "inst-1")).toEqual({ ok: false, error: "unsupported" });
  });
});
