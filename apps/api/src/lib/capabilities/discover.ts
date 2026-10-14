/**
 * Provider discovery: open an MCP endpoint with the credential the admin
 * described, page through tools/list, and return the subset Bcontext can
 * register. Shared by the REST route (the web UI) and the MCP
 * `capabilities(op=discover)` tool so both surfaces see the same tools under
 * the same egress rules — pinned hosts, response cap, one timeout.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { z } from "zod";
import { appendAudit } from "@/lib/audit";
import type { CapabilityConnectionInputSchema } from "./admin-schemas";
import { createPinnedFetch, EgressPolicyError, withResponseSizeLimit } from "./egress";
import { CapabilityOAuthError, getOAuthAccessTokenForAttempt } from "./oauth";
import { discoverProviderLogo, type DiscoveredProviderLogo } from "./provider-brand";
import { inferProviderMetadata, type DiscoveredProviderMetadata } from "./provider-metadata";
import { RemoteToolContractSchema } from "./types";

export type CapabilityConnectionInput = z.infer<typeof CapabilityConnectionInputSchema>;

export class CapabilityDiscoveryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: number,
  ) {
    super(message);
    this.name = "CapabilityDiscoveryError";
  }
}

export interface DiscoverProviderInput {
  workspaceId: string;
  /** Who is asking — owns the OAuth attempt and signs the audit row. */
  userId: string;
  connection: CapabilityConnectionInput;
  /** How the audit row names the actor; the MCP passes its token id. */
  actor?: { actorType: "user" | "agent"; agentTokenId?: string | null };
}

export interface DiscoverProviderResult {
  tools: z.infer<typeof RemoteToolContractSchema>[];
  truncated: boolean;
  logo_url: string | null;
  logo: DiscoveredProviderLogo | null;
  provider: DiscoveredProviderMetadata;
}

const MAX_MCP_DISCOVERY_RESPONSE_BYTES = 4_000_000;
const MAX_DISCOVERED_TOOLS = 100;

/**
 * Connects once under the connection's timeout, lists tools (capped), and
 * returns the valid ones plus the hostname-anchored provider identity and,
 * best effort, a logo. Failures are `CapabilityDiscoveryError`s with an HTTP
 * status the route can answer with.
 */
export async function discoverProviderTools(input: DiscoverProviderInput): Promise<DiscoverProviderResult> {
  const { connection } = input;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Provider discovery timed out", "TimeoutError")),
    connection.timeoutMs,
  );
  try {
    const headers = await discoveryHeaders(input, controller.signal);
    const client = new Client({ name: "bcontext-provider-discovery", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(connection.endpointUrl), {
      requestInit: { headers, signal: controller.signal },
      fetch: withResponseSizeLimit(
        createPinnedFetch(connection.allowedHosts),
        MAX_MCP_DISCOVERY_RESPONSE_BYTES,
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
      const discovered: Array<{
        name: string;
        description?: string;
        inputSchema: Record<string, unknown>;
        outputSchema?: Record<string, unknown>;
      }> = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, {
          signal: controller.signal,
          timeout: connection.timeoutMs,
          maxTotalTimeout: connection.timeoutMs,
        });
        discovered.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor && discovered.length < MAX_DISCOVERED_TOOLS);
      const truncated = Boolean(cursor) || discovered.length > MAX_DISCOVERED_TOOLS;
      const tools = discovered.slice(0, MAX_DISCOVERED_TOOLS).flatMap((tool) => {
        const parsed = RemoteToolContractSchema.safeParse({
          name: tool.name,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema,
          ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        });
        return parsed.success ? [parsed.data] : [];
      });
      if (tools.length === 0) {
        throw new CapabilityDiscoveryError("no_tools", "The MCP server returned no compatible tools", 422);
      }
      const endpoint = new URL(connection.endpointUrl);
      const serverInfo = client.getServerVersion();
      const provider = inferProviderMetadata(endpoint, serverInfo);
      const declaredIcons = serverInfo?.icons?.slice(0, 8).map((icon) => icon.src) ?? [];
      const logo = await discoverProviderLogo(
        endpoint,
        controller.signal,
        undefined,
        declaredIcons,
      ).catch(() => null);
      void appendAudit({
        workspaceId: input.workspaceId,
        actorType: input.actor?.actorType ?? "user",
        actorId: input.userId,
        agentTokenId: input.actor?.agentTokenId ?? null,
        action: "capability.provider.discover",
        targetType: "mcp_server",
        input: { endpoint_host: endpoint.hostname },
        output: { tool_count: tools.length },
      });
      return { tools, truncated, logo_url: logo?.url ?? null, logo, provider };
    } catch (error) {
      if (error instanceof CapabilityDiscoveryError) throw error;
      if (error instanceof EgressPolicyError) {
        throw new CapabilityDiscoveryError(error.code, error.message, 400);
      }
      if (controller.signal.aborted) {
        throw new CapabilityDiscoveryError("discovery_timeout", "The MCP server did not respond in time", 504);
      }
      throw new CapabilityDiscoveryError("discovery_failed", safeMessage(error), 502);
    } finally {
      await client.close().catch(() => {});
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function discoveryHeaders(input: DiscoverProviderInput, signal: AbortSignal): Promise<Headers> {
  const { connection } = input;
  const headers = new Headers();
  if (connection.authType === "oauth") {
    try {
      const accessToken = await getOAuthAccessTokenForAttempt({
        workspaceId: input.workspaceId,
        userId: input.userId,
        attemptId: connection.oauthAttemptId!,
        endpointUrl: connection.endpointUrl,
        signal,
      });
      headers.set("authorization", `${accessToken.tokenType} ${accessToken.accessToken}`);
    } catch (error) {
      if (signal.aborted) {
        throw new CapabilityDiscoveryError("discovery_timeout", "The MCP server did not respond in time", 504);
      }
      const known = error instanceof CapabilityOAuthError ? error : null;
      throw new CapabilityDiscoveryError(
        known?.code ?? "oauth_credential_unavailable",
        known?.message ?? "Provider authorization is unavailable",
        known?.httpStatus ?? 409,
      );
    }
  } else if (connection.authType !== "none") {
    // Discovery probes with the token the admin just pasted: nothing has
    // been stored yet, so there is no Vault round-trip here.
    const secret = connection.secret;
    if (!secret) {
      throw new CapabilityDiscoveryError("secret_unavailable", "Credential is required for this auth type", 409);
    }
    if (connection.authType === "bearer") headers.set("authorization", `Bearer ${secret}`);
    else headers.set(connection.authHeaderName ?? "x-api-key", secret);
  }
  return headers;
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unable to discover MCP tools";
  return message.replace(/bctx_live_[A-Za-z0-9]+/g, "[redacted]").slice(0, 240);
}
