/**
 * Invokes one external tool on behalf of an authorized MCP caller. Given an
 * `AuthorizedCapabilityTool` from the catalog it opens a
 * `capability_invocations` ledger row, applies the per-principal token bucket
 * (`consume_capability_rate_limit` RPC) and the per-capability circuit
 * breaker (`capability_runtime_state`), calls the provider — Streamable HTTP
 * MCP or a JSON webhook — through the pinned egress fetch under one timeout,
 * validates the output schema and closes the ledger row.
 *
 * Every failure becomes a `CapabilityGatewayError` with a stable `code`;
 * policy and credential errors do not count toward opening the circuit
 * (`countsTowardCircuit`). Called only from the MCP server's `tools/call`.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { appendAudit } from "@/lib/audit";
import { correlationId } from "@bcontext-dev/contract/correlation";
import { getSecret } from "@/lib/connectors/secrets";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { createPinnedFetch, EgressPolicyError, withResponseSizeLimit } from "./egress";
import { CapabilityOAuthError, getOAuthAccessTokenForConnection } from "./oauth";
import type { AuthorizedCapabilityTool } from "./types";

/** Stable-coded failure; `retryAfterSec` is set for rate limit and open circuit. */
export class CapabilityGatewayError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}

export interface InvokeCapabilityContext {
  workspaceId: string;
  tokenId: string;
  signal?: AbortSignal;
}

const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_OPEN_MS = 60_000;
const MAX_WEBHOOK_RESPONSE_BYTES = 1_000_000;
const MAX_MCP_RESPONSE_BYTES = 8_000_000;

/**
 * Runs one authorized call end to end (ledger, limits, provider, output
 * validation) and returns the provider's MCP-shaped result with the
 * invocation id and duration attached. Throws `CapabilityGatewayError` only.
 */
export async function invokeAuthorizedCapability(
  tool: AuthorizedCapabilityTool,
  args: Record<string, unknown>,
  ctx: InvokeCapabilityContext,
): Promise<Record<string, unknown>> {
  const sb = getSupabaseAdmin();
  const startedAt = Date.now();
  const { data: invocation, error: insertError } = await sb
    .from("capability_invocations")
    .insert({
      workspace_id: ctx.workspaceId,
      capability_id: tool.capabilityId,
      capability_version_id: tool.capabilityVersionId,
      principal_id: tool.principalId,
      agent_token_id: ctx.tokenId,
      tool_name: tool.ref,
      authorization: "allowed",
      status: "started",
      correlation_id: correlationId() ?? null,
    })
    .select("id")
    .single();
  if (insertError || !invocation) {
    throw new CapabilityGatewayError("audit_unavailable", "capability invocation ledger is unavailable");
  }
  const invocationId = invocation.id as string;
  void appendAudit({
    workspaceId: ctx.workspaceId,
    actorType: "agent",
    agentTokenId: ctx.tokenId,
    action: "capability.invoke.attempt",
    targetType: "capability",
    targetId: tool.capabilityId,
    input: { tool: tool.ref, args },
  });

  let timeoutController: AbortController | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  try {
    const rl = await consumeDistributedRateLimit(tool);
    if (!rl.ok) {
      throw new CapabilityGatewayError(
        "rate_limited",
        "capability rate limit exceeded",
        rl.retryAfterSec,
      );
    }
    await assertCircuitClosed(tool);
    timeoutController = new AbortController();
    timeout = setTimeout(
      () => timeoutController?.abort(new DOMException("Capability timed out", "TimeoutError")),
      effectiveTimeout(tool),
    );
    const signal = anySignal([ctx.signal, timeoutController.signal]);
    const result = tool.contract.protocol === "mcp_streamable_http"
      ? await invokeMcp(tool, args, signal)
      : await invokeWebhook(tool, args, invocationId, signal);
    validateOutput(tool, result);
    const duration = Date.now() - startedAt;
    await finishInvocation(invocationId, "succeeded", duration, null, extractCost(result));
    await recordCircuitSuccess(tool);
    void appendAudit({
      workspaceId: ctx.workspaceId,
      actorType: "agent",
      agentTokenId: ctx.tokenId,
      action: "capability.invoke.succeeded",
      targetType: "capability",
      targetId: tool.capabilityId,
      output: { duration_ms: duration, cost_microunits: extractCost(result) },
    });
    return normalizeResult(result, invocationId, duration);
  } catch (error) {
    const duration = Date.now() - startedAt;
    const timedOut = Boolean(timeoutController?.signal.aborted);
    const cancelled = !timedOut && Boolean(ctx.signal?.aborted);
    const status = timedOut ? "timed_out" : cancelled ? "cancelled" : "failed";
    const code = gatewayErrorCode(error, status);
    await finishInvocation(invocationId, status, duration, code, null);
    if (!cancelled && countsTowardCircuit(code)) await recordCircuitFailure(tool);
    void appendAudit({
      workspaceId: ctx.workspaceId,
      actorType: "agent",
      agentTokenId: ctx.tokenId,
      action: `capability.invoke.${status}`,
      targetType: "capability",
      targetId: tool.capabilityId,
      output: { duration_ms: duration, error_code: code },
    });
    if (error instanceof CapabilityGatewayError) throw error;
    if (error instanceof EgressPolicyError) {
      throw new CapabilityGatewayError(error.code, error.message);
    }
    throw new CapabilityGatewayError(code, safeErrorMessage(error));
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function consumeDistributedRateLimit(
  tool: AuthorizedCapabilityTool,
): Promise<{ ok: boolean; retryAfterSec: number }> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb.rpc("consume_capability_rate_limit", {
    p_workspace_id: tool.workspaceId,
    p_principal_id: tool.principalId,
    p_capability_id: tool.capabilityId,
    p_capacity: 20,
    p_refill_per_second: 0.25,
  }).single();
  if (error || !data) {
    throw new CapabilityGatewayError(
      "rate_limit_unavailable",
      "capability rate limiter is unavailable",
    );
  }
  return {
    ok: Boolean(data.allowed),
    retryAfterSec: Number(data.retry_after_sec ?? 0),
  };
}

// One transparent retry with a forced token refresh: a 401 from an OAuth
// provider usually means the access token expired between refreshes.
async function invokeMcp(
  tool: AuthorizedCapabilityTool,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  try {
    return await invokeMcpOnce(tool, args, signal, false);
  } catch (error) {
    if (tool.connection.authType !== "oauth" || !isUnauthorizedTransportError(error)) throw error;
    return invokeMcpOnce(tool, args, signal, true);
  }
}

async function invokeMcpOnce(
  tool: AuthorizedCapabilityTool,
  args: Record<string, unknown>,
  signal: AbortSignal,
  forceOAuthRefresh: boolean,
): Promise<Record<string, unknown>> {
  const headers = await authHeaders(tool, forceOAuthRefresh, signal);
  const client = new Client({ name: "bcontext-capability-gateway", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(tool.connection.endpointUrl), {
    requestInit: { headers, signal },
    fetch: withResponseSizeLimit(
      createPinnedFetch(tool.connection.allowedHosts),
      MAX_MCP_RESPONSE_BYTES,
    ),
    reconnectionOptions: {
      maxReconnectionDelay: 1000,
      initialReconnectionDelay: 250,
      reconnectionDelayGrowFactor: 1.5,
      maxRetries: 0,
    },
  });
  try {
    await client.connect(transport);
    return await client.callTool(
      { name: tool.remoteName, arguments: args },
      undefined,
      { signal, timeout: effectiveTimeout(tool), maxTotalTimeout: effectiveTimeout(tool) },
    ) as Record<string, unknown>;
  } finally {
    await client.close().catch(() => {});
  }
}

async function invokeWebhook(
  tool: AuthorizedCapabilityTool,
  args: Record<string, unknown>,
  invocationId: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (tool.contract.protocol !== "webhook") throw new Error("invalid webhook contract");
  if (tool.connection.authType === "oauth") {
    throw new CapabilityGatewayError("oauth_webhook_unsupported", "managed OAuth is supported only for MCP servers");
  }
  const endpoint = new URL(tool.connection.endpointUrl);
  if (tool.contract.path) endpoint.pathname = tool.contract.path;
  const headers = await authHeaders(tool, false, signal);
  headers.set("content-type", "application/json");
  headers.set("accept", "application/json");
  if (tool.contract.idempotencyHeader) headers.set(tool.contract.idempotencyHeader, invocationId);
  const pinnedFetch = createPinnedFetch(tool.connection.allowedHosts);
  const attempts = tool.contract.safeRetry && tool.contract.idempotencyHeader ? 2 : 1;
  let response: Response | null = null;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      response = await pinnedFetch(endpoint, {
        method: tool.contract.method,
        headers,
        body: JSON.stringify(args),
        signal,
      });
      if (!shouldRetryStatus(response.status) || attempt === attempts - 1) break;
      await response.body?.cancel();
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) throw error;
    }
  }
  if (!response) throw lastError ?? new Error("webhook returned no response");
  const body = await readLimited(response, MAX_WEBHOOK_RESPONSE_BYTES);
  if (!response.ok) {
    throw new CapabilityGatewayError(
      `upstream_${response.status}`,
      `capability provider returned HTTP ${response.status}`,
    );
  }
  let data: unknown = null;
  if (body.length > 0) {
    try { data = JSON.parse(body); }
    catch { data = { text: body }; }
  }
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data && typeof data === "object" ? data : { value: data },
  };
}

async function authHeaders(
  tool: AuthorizedCapabilityTool,
  forceOAuthRefresh = false,
  signal?: AbortSignal,
): Promise<Headers> {
  const headers = new Headers();
  const { authType, authHeaderName, secretRef } = tool.connection;
  if (authType === "none") return headers;
  if (authType === "oauth") {
    try {
      const access = await getOAuthAccessTokenForConnection({
        workspaceId: tool.workspaceId,
        connectionId: tool.connection.id,
        forceRefresh: forceOAuthRefresh,
        signal,
      });
      headers.set("authorization", `${access.tokenType} ${access.accessToken}`);
      return headers;
    } catch (error) {
      if (error instanceof CapabilityOAuthError) {
        throw new CapabilityGatewayError(error.code, error.message);
      }
      throw error;
    }
  }
  if (!secretRef) throw new CapabilityGatewayError("secret_ref_missing", "capability credential reference is missing");
  // The row holds a Vault reference; the token itself is read per call and
  // never cached, so a rotation from the product applies immediately.
  const secret = await getSecret(secretRef);
  if (!secret) throw new CapabilityGatewayError("secret_unavailable", "capability credential is not available");
  if (authType === "bearer") {
    headers.set("authorization", `Bearer ${secret}`);
  }
  else headers.set(authHeaderName ?? "x-api-key", secret);
  return headers;
}

/** The MCP transport's HTTP 401, as opposed to a tool-level error result. */
export function isUnauthorizedTransportError(error: unknown): boolean {
  return error instanceof StreamableHTTPError && error.code === 401;
}

async function assertCircuitClosed(tool: AuthorizedCapabilityTool): Promise<void> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("capability_runtime_state")
    .select("circuit_open_until")
    .eq("workspace_id", tool.workspaceId)
    .eq("capability_id", tool.capabilityId)
    .maybeSingle();
  if (error) throw new CapabilityGatewayError("runtime_state_unavailable", "capability runtime state is unavailable");
  const openUntil = data?.circuit_open_until as string | null | undefined;
  if (openUntil && Date.parse(openUntil) > Date.now()) {
    throw new CapabilityGatewayError(
      "circuit_open",
      "capability is temporarily unavailable after repeated failures",
      Math.max(1, Math.ceil((Date.parse(openUntil) - Date.now()) / 1000)),
    );
  }
}

async function recordCircuitSuccess(tool: AuthorizedCapabilityTool): Promise<void> {
  const sb = getSupabaseAdmin();
  await sb.from("capability_runtime_state").upsert({
    capability_id: tool.capabilityId,
    workspace_id: tool.workspaceId,
    consecutive_failures: 0,
    circuit_open_until: null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "capability_id" });
}

async function recordCircuitFailure(tool: AuthorizedCapabilityTool): Promise<void> {
  const sb = getSupabaseAdmin();
  const { data } = await sb
    .from("capability_runtime_state")
    .select("consecutive_failures,workspace_id")
    .eq("workspace_id", tool.workspaceId)
    .eq("capability_id", tool.capabilityId)
    .maybeSingle();
  const failures = Number(data?.consecutive_failures ?? 0) + 1;
  await sb.from("capability_runtime_state").upsert({
    capability_id: tool.capabilityId,
    workspace_id: tool.workspaceId,
    consecutive_failures: failures,
    last_failure_at: new Date().toISOString(),
    circuit_open_until:
      failures >= CIRCUIT_FAILURE_THRESHOLD
        ? new Date(Date.now() + CIRCUIT_OPEN_MS).toISOString()
        : null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "capability_id" });
}

async function finishInvocation(
  id: string,
  status: "succeeded" | "failed" | "timed_out" | "cancelled",
  durationMs: number,
  errorCode: string | null,
  costMicrounits: number | null,
): Promise<void> {
  const sb = getSupabaseAdmin();
  const { error } = await sb.from("capability_invocations").update({
    status,
    duration_ms: durationMs,
    error_code: errorCode,
    cost_microunits: costMicrounits,
  }).eq("id", id);
  if (error) console.warn("[capability.gateway.ledger_update_failed]", error.message);
}

function effectiveTimeout(tool: AuthorizedCapabilityTool): number {
  const constraint = Number(tool.constraints.max_timeout_ms);
  return Number.isFinite(constraint)
    ? Math.max(1000, Math.min(tool.connection.timeoutMs, constraint))
    : tool.connection.timeoutMs;
}

function normalizeResult(result: Record<string, unknown>, invocationId: string, durationMs: number): Record<string, unknown> {
  return {
    ...result,
    _meta: {
      ...(isRecord(result._meta) ? result._meta : {}),
      bcontext_gateway: { invocation_id: invocationId, duration_ms: durationMs },
    },
  };
}

function validateOutput(
  tool: AuthorizedCapabilityTool,
  result: Record<string, unknown>,
): void {
  if (!tool.outputSchema) return;
  const validator = new AjvJsonSchemaValidator().getValidator(tool.outputSchema as never);
  const validated = validator(result.structuredContent);
  if (!validated.valid) {
    throw new CapabilityGatewayError(
      "invalid_upstream_output",
      `capability returned data outside its registered output schema: ${validated.errorMessage}`,
    );
  }
}

function extractCost(result: Record<string, unknown>): number | null {
  const meta = isRecord(result._meta) ? result._meta : null;
  const cost = meta?.cost_microunits;
  return typeof cost === "number" && Number.isSafeInteger(cost) && cost >= 0 ? cost : null;
}

function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  return active.length === 1 ? active[0]! : AbortSignal.any(active);
}

function shouldRetryStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new CapabilityGatewayError("response_too_large", "capability response exceeded 1 MB");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(body);
}

function gatewayErrorCode(error: unknown, status: string): string {
  if (error instanceof CapabilityGatewayError || error instanceof EgressPolicyError) return error.code;
  if (status === "timed_out") return "timeout";
  if (status === "cancelled") return "cancelled";
  return "upstream_error";
}

function countsTowardCircuit(code: string): boolean {
  return ![
    "rate_limited",
    "rate_limit_unavailable",
    "circuit_open",
    "secret_ref_missing",
    "secret_unavailable",
    "oauth_reauthorization_required",
    "oauth_credential_not_found",
    "oauth_credential_unavailable",
    "oauth_tokens_missing",
    "oauth_refresh_token_missing",
    "oauth_secret_unavailable",
    "oauth_secret_invalid",
    "oauth_webhook_unsupported",
    "https_required",
    "url_credentials_forbidden",
    "local_host_forbidden",
    "host_not_allowed",
    "private_address_forbidden",
    "dns_empty",
    "unsupported_body",
    "cancelled",
  ].includes(code);
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "capability invocation was cancelled";
  if (error instanceof Error && error.name === "TimeoutError") return "capability invocation timed out";
  return "capability provider request failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
