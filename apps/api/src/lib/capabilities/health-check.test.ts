import { describe, expect, it } from "vitest";
import { runCapabilityHealthChecks } from "./health-check";

interface CapabilityRow {
  id: string;
  workspace_id: string;
  type: string;
  current_version_id: string | null;
  status: string;
  deleted_at: string | null;
}

interface VersionRow {
  id: string;
  contract: Record<string, unknown>;
  contract_digest: string;
}

interface ConnectionRow {
  id: string;
  capability_id: string;
  endpoint_url: string;
  auth_type: string;
  auth_header_name: string | null;
  secret_ref: string | null;
  allowed_hosts: string[];
  timeout_ms: number;
  enabled: boolean;
}

/**
 * Chainable Supabase-admin stub, table-keyed like the webhook worker test.
 * Only the query shapes `runCapabilityHealthChecks` actually issues are
 * implemented.
 */
function makeAdmin(state: {
  capabilities: CapabilityRow[];
  versions: VersionRow[];
  connections: ConnectionRow[];
  upserts: Array<Record<string, unknown>>;
}) {
  const builder = (table: string) => {
    const filters: Record<string, unknown> = {};
    const self = {
      select: () => self,
      eq: (k: string, v: unknown) => {
        filters[k] = v;
        return self;
      },
      in: () => self,
      is: () => self,
      limit: () => Promise.resolve({ data: state.capabilities, error: null }),
      maybeSingle: () => {
        if (table === "capability_versions") {
          const row = state.versions.find((v) => v.id === filters.id);
          return Promise.resolve({ data: row ?? null, error: null });
        }
        if (table === "capability_connections") {
          const row = state.connections.find((c) => c.capability_id === filters.capability_id);
          return Promise.resolve({ data: row ?? null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      upsert: (patch: Record<string, unknown>) => {
        state.upserts.push(patch);
        return Promise.resolve({ data: null, error: null });
      },
    };
    return self;
  };
  return { from: (table: string) => builder(table) } as unknown as Parameters<typeof runCapabilityHealthChecks>[0];
}

describe("runCapabilityHealthChecks", () => {
  it("marks a webhook capability unhealthy when its endpoint host is not allowlisted", async () => {
    const admin = makeAdmin({
      capabilities: [
        { id: "cap-1", workspace_id: "ws-1", type: "workflow", current_version_id: "v-1", status: "approved", deleted_at: null },
      ],
      versions: [
        { id: "v-1", contract: { protocol: "webhook", tool: { name: "run", inputSchema: {} }, method: "POST", safeRetry: false }, contract_digest: "digest-1" },
      ],
      connections: [
        {
          id: "conn-1",
          capability_id: "cap-1",
          endpoint_url: "https://example.test/hook",
          auth_type: "none",
          auth_header_name: null,
          secret_ref: null,
          allowed_hosts: ["other-host.test"],
          timeout_ms: 5000,
          enabled: true,
        },
      ],
      upserts: [],
    });

    const result = await runCapabilityHealthChecks(admin);

    expect(result.checked).toBe(1);
    expect(result.unhealthy).toBe(1);
    expect(result.healthy).toBe(0);
    expect(result.drift_detected).toBe(0);
  });

  it("skips capabilities with no current version or no enabled connection", async () => {
    const admin = makeAdmin({
      capabilities: [
        { id: "cap-no-version", workspace_id: "ws-1", type: "workflow", current_version_id: null, status: "approved", deleted_at: null },
        { id: "cap-no-connection", workspace_id: "ws-1", type: "workflow", current_version_id: "v-2", status: "approved", deleted_at: null },
      ],
      versions: [
        { id: "v-2", contract: { protocol: "webhook", tool: { name: "run", inputSchema: {} }, method: "POST", safeRetry: false }, contract_digest: "digest-2" },
      ],
      connections: [],
      upserts: [],
    });

    const result = await runCapabilityHealthChecks(admin);

    expect(result.checked).toBe(0);
    expect(result.skipped).toBe(2);
  });

  it("records a disabled connection as skipped rather than unhealthy", async () => {
    const admin = makeAdmin({
      capabilities: [
        { id: "cap-1", workspace_id: "ws-1", type: "api", current_version_id: "v-1", status: "approved", deleted_at: null },
      ],
      versions: [
        { id: "v-1", contract: { protocol: "webhook", tool: { name: "run", inputSchema: {} }, method: "POST", safeRetry: false }, contract_digest: "digest-1" },
      ],
      connections: [
        {
          id: "conn-1",
          capability_id: "cap-1",
          endpoint_url: "https://example.test/hook",
          auth_type: "none",
          auth_header_name: null,
          secret_ref: null,
          allowed_hosts: ["example.test"],
          timeout_ms: 5000,
          enabled: false,
        },
      ],
      upserts: [],
    });

    const result = await runCapabilityHealthChecks(admin);
    expect(result.checked).toBe(0);
    expect(result.skipped).toBe(1);
  });
});
