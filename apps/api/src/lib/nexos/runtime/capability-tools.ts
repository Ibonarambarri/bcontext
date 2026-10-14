/**
 * The external capabilities granted to a Nexo, as two AI SDK tools:
 * `capability_search` (find what it may call) and `capability_call` (call one
 * by ref). The same pair the MCP server exposes, for the same reason: the
 * tool list stays small and fixed whatever has been granted, and schemas are
 * paid for only when the model asks.
 *
 * Callers: the headless runner (`./runner`). Resolution goes through the
 * gateway's own catalog (`listAuthorizedCapabilityTools`) with the Nexo's
 * agent id as principal, and every call re-resolves the ref and runs through
 * `invokeAuthorizedCapability` — ledger, rate limit, circuit breaker, egress
 * policy — exactly like an MCP `capability_call`. There is no token behind a
 * Nexo, so the agent id stands in as `tokenId` (the ledger and audit columns
 * it lands in are plain uuids and then name the Nexo).
 *
 * Must not break: authorization is re-read on every call, so revoking a grant
 * in Herramientas takes effect mid-run. Workspace skills are not bridged: a
 * skill run is a second model call billed outside the Nexo's budget.
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { Nexo } from "@bcontext-dev/contract/nexos";
import { listAuthorizedCapabilityTools } from "@/lib/capabilities/catalog";
import { CapabilityGatewayError, invokeAuthorizedCapability } from "@/lib/capabilities/gateway";
import type { AuthorizedCapabilityTool } from "@/lib/capabilities/types";
import { searchCapabilities } from "@/lib/mcp/capability-search";

export interface CapabilityBridgeDeps {
  nexo: Pick<Nexo, "workspace_id" | "agent_id">;
  /** Aborts in-flight external calls when the run is cancelled. */
  signal?: AbortSignal;
  /** Test seam; defaults to the gateway catalog. */
  list?: () => Promise<AuthorizedCapabilityTool[]>;
  invoke?: typeof invokeAuthorizedCapability;
}

/** The two bridge tools, or none when the Nexo has nothing granted. */
export async function buildCapabilityTools(deps: CapabilityBridgeDeps): Promise<ToolSet> {
  const list =
    deps.list ??
    (() =>
      listAuthorizedCapabilityTools({
        workspaceId: deps.nexo.workspace_id,
        tokenId: deps.nexo.agent_id,
        tokenScope: "workspace",
        agentId: deps.nexo.agent_id,
      }));
  const invoke = deps.invoke ?? invokeAuthorizedCapability;

  // One read up front decides whether to offer the pair at all: a Nexo with
  // no grants should not spend prompt tokens on tools that can only fail.
  let initial: AuthorizedCapabilityTool[];
  try {
    initial = await list();
  } catch {
    return {};
  }
  if (initial.length === 0) return {};

  return {
    capability_search: tool({
      description:
        "Find external tools you have been granted (connected apps, webhooks). Returns refs like `<provider>/<capability>/<tool>` with their input schema when there are few hits. `*` lists everything.",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(200),
        provider: z.string().trim().min(1).max(100).optional(),
        limit: z.number().int().min(1).max(25).default(10),
      }),
      execute: async (input) => {
        const tools = await list();
        return searchCapabilities(input, tools, []);
      },
    }),
    capability_call: tool({
      description:
        "Call one external tool by the `ref` capability_search returned, with `args` matching its input_schema. Do not retry unless the error says to.",
      inputSchema: z.object({
        ref: z.string().trim().min(1).max(400),
        args: z.record(z.unknown()).default({}),
      }),
      execute: async ({ ref, args }) => {
        const external = (await list()).find((t) => t.ref === ref);
        if (!external) return { ok: false, error: `unknown or unauthorized ref: ${ref}` };
        const validated = new AjvJsonSchemaValidator().getValidator(external.inputSchema as never)(args);
        if (!validated.valid) return { ok: false, error: `invalid arguments: ${validated.errorMessage}` };
        try {
          const result = await invoke(external, validated.data as Record<string, unknown>, {
            workspaceId: deps.nexo.workspace_id,
            tokenId: deps.nexo.agent_id,
            signal: deps.signal,
          });
          return { ok: true, ref, result };
        } catch (err) {
          if (err instanceof CapabilityGatewayError) {
            return {
              ok: false,
              error: `${err.code}: ${err.message}${err.retryAfterSec ? ` (retry after ${err.retryAfterSec}s)` : ""}`,
            };
          }
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    }),
  };
}
