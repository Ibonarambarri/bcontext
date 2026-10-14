/**
 * Capability health-check + schema-drift detection.
 *
 * Runs periodically (pg-boss job `capability.health-check`) over every
 * `approved` executable capability (`mcp_server` | `api` | `workflow`) and
 * records the outcome in `capability_runtime_state`, so a capability's
 * health no longer depends on someone having invoked it recently.
 *
 * - `mcp_server`: connects over Streamable HTTP (same transport as
 *   `/api/capabilities/discover`), lists tools, and diffs the freshly
 *   fetched contract's digest against the stored `capability_versions`
 *   digest. A mismatch is schema drift — the provider changed its tools
 *   without going through the registration flow.
 * - `api` | `workflow` (webhook): the contract is admin-declared, not
 *   discoverable, and invoking the endpoint would trigger real side
 *   effects. Health here is therefore a reachability check only
 *   (SSRF-safe DNS/allowlist resolution of the endpoint host) — no drift
 *   detection is possible for webhooks without executing them.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sha256Hex, stableJson } from "@/lib/audit";
import {
  createPinnedFetch,
  EgressPolicyError,
  resolveSafeTarget,
  withResponseSizeLimit,
} from "@/lib/capabilities/egress";
import { getOAuthAccessTokenForConnection } from "@/lib/capabilities/oauth";
import { getSecret } from "@/lib/connectors/secrets";
import { RemoteToolContractSchema } from "@/lib/capabilities/types";
import { log } from "@bcontext-dev/contract/log";

const MAX_MCP_RESPONSE_BYTES = 4_000_000;
const MAX_CAPABILITIES_PER_RUN = 200;

interface CapabilityRow {
  id: string;
  workspace_id: string;
  type: string;
  current_version_id: string | null;
}

interface VersionRow {
  contract: Record<string, unknown>;
  contract_digest: string;
}

interface ConnectionRow {
  id: string;
  endpoint_url: string;
  auth_type: string;
  auth_header_name: string | null;
  secret_ref: string | null;
  allowed_hosts: string[];
  timeout_ms: number;
  enabled: boolean;
}

export interface HealthCheckResult {
  checked: number;
  healthy: number;
  unhealthy: number;
  drift_detected: number;
  skipped: number;
}

/** One run over up to `MAX_CAPABILITIES_PER_RUN` approved capabilities; returns counters. */
export async function runCapabilityHealthChecks(admin: SupabaseClient): Promise<HealthCheckResult> {
  const { data: capabilities, error } = await admin
    .from("capabilities")
    .select("id,workspace_id,type,current_version_id")
    .eq("status", "approved")
    .in("type", ["mcp_server", "api", "workflow"])
    .is("deleted_at", null)
    .limit(MAX_CAPABILITIES_PER_RUN);
  if (error) {
    log.error("capability_health_check.list_failed", { message: error.message });
    return { checked: 0, healthy: 0, unhealthy: 0, drift_detected: 0, skipped: 0 };
  }

  const result: HealthCheckResult = { checked: 0, healthy: 0, unhealthy: 0, drift_detected: 0, skipped: 0 };
  for (const capability of (capabilities ?? []) as CapabilityRow[]) {
    if (!capability.current_version_id) {
      result.skipped += 1;
      continue;
    }
    const [{ data: version }, { data: connection }] = await Promise.all([
      admin
        .from("capability_versions")
        .select("contract,contract_digest")
        .eq("id", capability.current_version_id)
        .maybeSingle(),
      admin
        .from("capability_connections")
        .select("id,endpoint_url,auth_type,auth_header_name,secret_ref,allowed_hosts,timeout_ms,enabled")
        .eq("capability_id", capability.id)
        .eq("environment", "production")
        .maybeSingle(),
    ]);
    if (!version || !connection || !connection.enabled) {
      result.skipped += 1;
      continue;
    }
    result.checked += 1;
    const outcome = capability.type === "mcp_server"
      ? await checkMcpServer(capability.workspace_id, version as VersionRow, connection as ConnectionRow)
      : await checkWebhookReachability(connection as ConnectionRow);
    if (outcome.healthStatus === "healthy") result.healthy += 1;
    else result.unhealthy += 1;
    if (outcome.schemaDrift) result.drift_detected += 1;

    await admin.from("capability_runtime_state").upsert({
      capability_id: capability.id,
      workspace_id: capability.workspace_id,
      last_checked_at: new Date().toISOString(),
      health_status: outcome.healthStatus,
      last_error: outcome.lastError,
      schema_drift: outcome.schemaDrift,
      drift_detected_at: outcome.schemaDrift ? new Date().toISOString() : null,
      drift_summary: outcome.driftSummary ?? null,
    }, { onConflict: "capability_id" });
  }
  return result;
}

interface CheckOutcome {
  healthStatus: "healthy" | "unhealthy";
  lastError: string | null;
  schemaDrift: boolean;
  driftSummary?: Record<string, unknown> | null;
}

async function checkMcpServer(workspaceId: string, version: VersionRow, connection: ConnectionRow): Promise<CheckOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Health check timed out", "TimeoutError")),
    connection.timeout_ms,
  );
  const headers = new Headers();
  try {
    if (connection.auth_type === "oauth") {
      const accessToken = await getOAuthAccessTokenForConnection({
        workspaceId,
        connectionId: connection.id,
        signal: controller.signal,
      });
      headers.set("authorization", `${accessToken.tokenType} ${accessToken.accessToken}`);
    } else if (connection.auth_type !== "none") {
      const secret = await getSecret(connection.secret_ref);
      if (!secret) throw new Error("credential not available");
      if (connection.auth_type === "bearer") headers.set("authorization", `Bearer ${secret}`);
      else headers.set(connection.auth_header_name ?? "x-api-key", secret);
    }

    const client = new Client({ name: "bcontext-capability-health-check", version: "0.1.0" });
    const pinnedFetch = withResponseSizeLimit(createPinnedFetch(connection.allowed_hosts), MAX_MCP_RESPONSE_BYTES);
    const transport = new StreamableHTTPClientTransport(new URL(connection.endpoint_url), {
      requestInit: { headers, signal: controller.signal },
      fetch: pinnedFetch,
      reconnectionOptions: {
        maxReconnectionDelay: 1000,
        initialReconnectionDelay: 250,
        reconnectionDelayGrowFactor: 1.5,
        maxRetries: 0,
      },
    });
    try {
      await client.connect(transport);
      const discovered: Array<{ name: string; description?: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown> }> = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, {
          signal: controller.signal,
          timeout: connection.timeout_ms,
          maxTotalTimeout: connection.timeout_ms,
        });
        discovered.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor && discovered.length < 100);
      const tools = discovered.slice(0, 100).flatMap((tool) => {
        const parsed = RemoteToolContractSchema.safeParse({
          name: tool.name,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema,
          ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        });
        return parsed.success ? [parsed.data] : [];
      });
      const liveContract = { protocol: "mcp_streamable_http" as const, tools };
      const liveDigest = await sha256Hex(stableJson(liveContract));
      const drift = liveDigest !== version.contract_digest;
      return {
        healthStatus: "healthy",
        lastError: null,
        schemaDrift: drift,
        driftSummary: drift
          ? { stored_tool_count: countTools(version.contract), live_tool_count: tools.length, live_digest: liveDigest }
          : null,
      };
    } finally {
      await client.close().catch(() => {});
    }
  } catch (error) {
    return {
      healthStatus: "unhealthy",
      lastError: safeErrorMessage(error),
      schemaDrift: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkWebhookReachability(connection: ConnectionRow): Promise<CheckOutcome> {
  try {
    await resolveSafeTarget(connection.endpoint_url, connection.allowed_hosts);
    return { healthStatus: "healthy", lastError: null, schemaDrift: false };
  } catch (error) {
    const message = error instanceof EgressPolicyError ? error.message : safeErrorMessage(error);
    return { healthStatus: "unhealthy", lastError: message, schemaDrift: false };
  }
}

function countTools(contract: Record<string, unknown>): number {
  const tools = (contract as { tools?: unknown[] }).tools;
  return Array.isArray(tools) ? tools.length : 0;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "capability health check failed";
  return message.replace(/bctx_live_[A-Za-z0-9]+/g, "[redacted]").slice(0, 240);
}
