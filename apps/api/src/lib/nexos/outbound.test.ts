/**
 * Outbound delivery: first-party Slack with the install's bot token, Slack
 * through the Nango proxy, the name override only when the scope was
 * granted, tenant isolation, and an audit row for every attempt.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { appendAudit } = vi.hoisted(() => ({ appendAudit: vi.fn(async (_entry: unknown) => null) }));
vi.mock("@/lib/audit", () => ({ appendAudit }));

import type { ConnectorInstall } from "@/lib/connectors/installs";
import { sendNexoMessage, setOutboundDepsForTests } from "./outbound";
import type { Nexo, NexoTarget } from "./types";

const t: NexoTarget = { workspaceId: "ws-out", backend: "supabase" };
const nexo = { id: "nexo-1", agent_id: "agent-1", name: "Soporte", workspace_id: "ws-out" } as Nexo;

function install(over: Partial<ConnectorInstall> = {}): ConnectorInstall {
  return {
    id: "inst-1",
    workspace_id: "ws-out",
    connector_id: "slack",
    config: { team_id: "T1", scopes: ["chat:write"] },
    secret_ref: `inline:${Buffer.from("xoxb-test").toString("base64")}`,
    status: "active",
    last_sync_at: null,
    last_error: null,
    created_at: "",
    updated_at: "",
    ...over,
  };
}

afterEach(() => {
  setOutboundDepsForTests(null);
  appendAudit.mockClear();
});

describe("sendNexoMessage", () => {
  it("posts in thread with the bot token and audits the send", async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true, ts: "2.000001" }));
    setOutboundDepsForTests({ fetch: fetch as unknown as typeof globalThis.fetch, getInstall: async () => install() });
    const res = await sendNexoMessage({ target: t, nexo, installId: "inst-1", channel: "C1", threadTs: "1.000001", text: "Hola" });
    expect(res).toEqual({ ok: true, ts: "2.000001" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer xoxb-test");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ channel: "C1", thread_ts: "1.000001", text: "Hola" });
    expect(body.username).toBeUndefined();
    expect(appendAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "nexo.message.send", actorId: "agent-1", targetId: "inst-1" }));
  });

  it("names the Nexo only when chat:write.customize was granted", async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true, ts: "3" }));
    setOutboundDepsForTests({
      fetch: fetch as unknown as typeof globalThis.fetch,
      getInstall: async () => install({ config: { scopes: "chat:write,chat:write.customize" } }),
    });
    await sendNexoMessage({ target: t, nexo, installId: "inst-1", channel: "C1", text: "Hola" });
    const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.username).toBe("Soporte");
    expect(body.thread_ts).toBeUndefined();
  });

  it("reports Slack errors without throwing", async () => {
    setOutboundDepsForTests({
      fetch: (async () => Response.json({ ok: false, error: "missing_scope" })) as unknown as typeof globalThis.fetch,
      getInstall: async () => install(),
    });
    const res = await sendNexoMessage({ target: t, nexo, installId: "inst-1", channel: "C1", text: "Hola" });
    expect(res).toEqual({ ok: false, error: "missing_scope" });
    expect(appendAudit).toHaveBeenCalledTimes(1);
  });

  it("goes through the Nango proxy for a Nango Slack install", async () => {
    const proxy = vi.fn(async () => ({ ok: true, status: 200, data: { ok: true, ts: "4" }, headers: new Headers() }));
    setOutboundDepsForTests({
      nango: (() => ({ proxy })) as never,
      getInstall: async () =>
        install({ connector_id: "slack-nango" as never, secret_ref: null, config: { provider: "nango", nango_connection_id: "conn-1", nango_integration_key: "slack-nango--ws" } }),
    });
    const res = await sendNexoMessage({ target: t, nexo, installId: "inst-1", channel: "C1", threadTs: "1.1", text: "Hola" });
    expect(res).toEqual({ ok: true, ts: "4" });
    expect(proxy).toHaveBeenCalledWith(expect.objectContaining({
      method: "POST",
      path: "/chat.postMessage",
      connectionId: "conn-1",
      providerConfigKey: "slack-nango--ws",
      body: expect.objectContaining({ channel: "C1", thread_ts: "1.1" }),
    }));
  });

  it("refuses other tenants' installs, inactive installs and other connectors", async () => {
    setOutboundDepsForTests({ getInstall: async () => install({ workspace_id: "ws-else" }) });
    expect(await sendNexoMessage({ target: t, nexo, installId: "inst-1", channel: "C1", text: "x" })).toEqual({ ok: false, error: "install_not_found" });
    setOutboundDepsForTests({ getInstall: async () => install({ status: "paused" }) });
    expect(await sendNexoMessage({ target: t, nexo, installId: "inst-1", channel: "C1", text: "x" })).toEqual({ ok: false, error: "install_inactive" });
    setOutboundDepsForTests({ getInstall: async () => install({ connector_id: "github" as never }) });
    expect(await sendNexoMessage({ target: t, nexo, installId: "inst-1", channel: "C1", text: "x" })).toEqual({ ok: false, error: "unsupported" });
  });
});
