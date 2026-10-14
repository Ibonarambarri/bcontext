/**
 * Shapes shared by the external-capability gateway: what a registered
 * capability's contract may be (`ExecutableContractSchema` — an MCP server's
 * tools or a single webhook), how a connection reaches it, and the fully
 * resolved `AuthorizedCapabilityTool` the catalog hands to the MCP server
 * and the gateway invokes. `CapabilityActor` identifies the caller whose
 * grants the catalog resolves.
 *
 * Only `mcp_server` | `api` | `workflow` are executable; the other
 * `CapabilityType`s are catalog entries the gateway never calls.
 */
import { z } from "zod";

export const CapabilityTypeSchema = z.enum([
  "mcp_server",
  "api",
  "workflow",
  "skill",
  "plugin",
  "script_or_cli",
  "agent",
]);
export type CapabilityType = z.infer<typeof CapabilityTypeSchema>;

const JsonSchema = z.record(z.unknown()).refine(
  (value) => value.type === "object" || typeof value.$ref === "string",
  "tool inputSchema must be an object schema or $ref",
);

export const RemoteToolContractSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(4000).default(""),
  inputSchema: JsonSchema,
  outputSchema: z.record(z.unknown()).optional(),
});

const McpCapabilityContractSchema = z.object({
  protocol: z.literal("mcp_streamable_http"),
  tools: z.array(RemoteToolContractSchema).min(1).max(100),
});

const WebhookCapabilityContractSchema = z.object({
  protocol: z.literal("webhook"),
  tool: RemoteToolContractSchema,
  method: z.enum(["POST", "PUT", "PATCH"]).default("POST"),
  path: z.string().startsWith("/").optional(),
  safeRetry: z.boolean().default(false),
  idempotencyHeader: z.string().min(1).max(100).optional(),
});

export const ExecutableContractSchema = z.discriminatedUnion("protocol", [
  McpCapabilityContractSchema,
  WebhookCapabilityContractSchema,
]);
export type ExecutableContract = z.infer<typeof ExecutableContractSchema>;

export interface CapabilityConnection {
  id: string;
  endpointUrl: string;
  authType: "none" | "oauth" | "bearer" | "header";
  authHeaderName: string | null;
  secretRef: string | null;
  allowedHosts: string[];
  timeoutMs: number;
}

export interface AuthorizedCapabilityTool {
  workspaceId: string;
  /** `<provider>/<capability>/<tool>` — the handle `capability_search` returns and `capability_call` takes. */
  ref: string;
  remoteName: string;
  description: string;
  capabilityTitle: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  capabilityId: string;
  capabilityVersionId: string;
  capabilityKey: string;
  capabilityType: CapabilityType;
  provider: string;
  principalId: string;
  contract: ExecutableContract;
  connection: CapabilityConnection;
  constraints: Record<string, unknown>;
}

export interface CapabilityActor {
  workspaceId: string;
  tokenId: string;
  tokenScope: "workspace" | "user";
  userId?: string;
  agentId?: string;
}
