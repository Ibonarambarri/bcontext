/**
 * Capability administration from the MCP: what the Tools page does, for an
 * agent holding the `admin` verb.
 *
 * Same rules as the UI, on purpose. Discovery goes through the one pinned
 * discovery path; registration through the same schema the REST route
 * validates (`RegisterCapabilityInputSchema`) and, for OAuth, the same
 * atomic RPC; disconnect through `remove_capability_provider`, which revokes
 * the grants and tombstones the row; grants are explicit rows — connecting
 * never grants anyone anything, not even the caller.
 *
 * The one thing the MCP adds is the OAuth hand-off: the agent gets the
 * authorization URL back, a person consents in a browser, and the agent polls
 * `status` until the attempt is `authorized`, then connects with it.
 */
import { z } from "zod";
import { appendAudit, sha256Hex, stableJson } from "@/lib/audit";
import { appUrl as configuredAppUrl, supabaseConfigured } from "@/lib/env";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { capabilityCredentialUsable } from "./admin";
import {
  CapabilityConnectionInputSchema,
  RegisterCapabilityInputSchema,
} from "./admin-schemas";
import { CapabilityDiscoveryError, discoverProviderTools } from "./discover";
import {
  CapabilityOAuthError,
  cancelOAuthAttempt,
  getOAuthAttemptStatus,
  registerOAuthCapability,
  startOAuthAuthorization,
} from "./oauth";
import { ConnectionSecretError, discardConnectionSecret, storeConnectionSecret } from "./connection-secret";
import { ExecutableContractSchema, type CapabilityType } from "./types";

/** Stable-coded refusal the MCP layer turns into a tool error for the agent. */
export class CapabilityAdminError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CapabilityAdminError";
  }
}

/** The MCP caller, as the catalog and the ledger identify it. */
export interface CapabilityAdminActor {
  workspaceId: string;
  /**
   * The person the change is attributed to: the user behind a user token, or
   * the creator of a workspace token. The OAuth attempt and the lifecycle RPCs
   * check this user is an owner/admin member — the verb check on the grant
   * happens before we get here, this is the database's own gate.
   */
  userId: string | null;
  tokenId: string;
  tokenScope: "workspace" | "user";
  agentId?: string;
  agentLabel?: string;
}

// ---- Inputs (zod: the MCP tool schema is derived from these) --------------

const CAPABILITY_TYPES = ["mcp_server", "api", "workflow", "skill", "plugin", "script_or_cli", "agent"] as const;
const CAPABILITY_STATUSES = ["draft", "approved", "deprecated", "disabled"] as const;

export const ListCapabilitiesInput = z.object({
  type: z.enum(CAPABILITY_TYPES).optional(),
  status: z.enum(CAPABILITY_STATUSES).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(200).default(50),
}).strict();

// Flat on purpose: a four-branch `oneOf` here would be inlined twice (discover
// and connect live in different tools, so `$defs` cannot share it) and cost
// every admin ~1.5 KB per turn. Which fields go with which type is enforced by
// `CapabilityConnectionInputSchema` when the connection is built.
const AuthInput = z.object({
  type: z.enum(["none", "bearer", "header", "oauth"]).default("none"),
  /** bearer/header: the token (write-only). */
  secret: z.string().min(1).max(4096).optional(),
  /** header: which header carries it. */
  header_name: z.string().min(1).max(100).optional(),
  /** oauth: an attempt that reached status 'authorized'. */
  attempt_id: z.string().uuid().optional(),
}).strict();

const EndpointInput = z.object({
  endpoint_url: z.string().url().refine((value) => new URL(value).protocol === "https:", "HTTPS required"),
  auth: AuthInput.default({ type: "none" }),
  timeout_ms: z.number().int().min(1000).max(55000).default(15000),
});

export const DiscoverCapabilityInput = EndpointInput.extend({
  include_schemas: z.boolean().default(false),
}).strict();

export const ConnectCapabilityInput = EndpointInput.extend({
  key: z.string().regex(/^[a-z][a-z0-9_-]{1,62}$/),
  type: z.enum(["mcp_server", "api", "workflow"]).default("mcp_server"),
  provider: z.string().trim().min(1).max(100).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
  /** Keep only these remote tools (mcp_server); omit for every discovered tool. */
  tools: z.array(z.string().min(1).max(128)).min(1).max(100).optional(),
  /** Required for api/workflow (a webhook contract); ignored for mcp_server. */
  contract: z.record(z.unknown()).optional(),
  status: z.enum(["draft", "approved"]).default("approved"),
}).strict();

export const CapabilityStatusInput = z.object({
  capability_id: z.string().uuid().optional(),
  attempt_id: z.string().uuid().optional(),
  /** With attempt_id: abandon a pending authorization. */
  cancel: z.boolean().optional(),
}).strict();

export const DisconnectCapabilityInput = z.object({
  capability_id: z.string().uuid(),
  expected_updated_at: z.string().datetime({ offset: true }).optional(),
}).strict();

export const GrantCapabilityInput = z.object({
  capability_id: z.string().uuid(),
  /** Omit to grant the calling principal. */
  principal: z.object({
    kind: z.enum(["user", "agent", "service_account"]),
    id: z.string().min(1).max(200),
    display_name: z.string().trim().min(1).max(200).optional(),
  }).strict().optional(),
  /** Constraint: only these remote tool names are exposed. */
  allowed_tools: z.array(z.string().min(1).max(128)).min(1).max(100).optional(),
  expires_at: z.string().datetime({ offset: true }).optional(),
}).strict();

export const RevokeCapabilityGrantInput = z.object({
  grant_id: z.string().uuid(),
}).strict();

// ---- Reads ----------------------------------------------------------------

interface CapabilityRow {
  id: string;
  key: string;
  type: CapabilityType;
  provider: string;
  title: string;
  description: string;
  status: string;
  current_version_id: string | null;
  updated_at: string;
}

/** `capabilities(op=list)`: the workspace catalogue with grant counts, for admins. */
export async function listCapabilities(
  actor: CapabilityAdminActor,
  input: z.infer<typeof ListCapabilitiesInput>,
) {
  requireDb();
  const sb = getSupabaseAdmin();
  let query = sb
    .from("capabilities")
    .select("id,key,type,provider,title,description,status,current_version_id,updated_at")
    .eq("workspace_id", actor.workspaceId)
    .is("deleted_at", null);
  if (input.type) query = query.eq("type", input.type);
  if (input.status) query = query.eq("status", input.status);
  if (input.q) {
    const escaped = input.q.replace(/[%_]/g, (match) => `\\${match}`);
    query = query.or(
      `title.ilike.%${escaped}%,description.ilike.%${escaped}%,provider.ilike.%${escaped}%,key.ilike.%${escaped}%`,
    );
  }
  const { data, error } = await query.order("created_at", { ascending: false }).limit(input.limit);
  if (error) throw new CapabilityAdminError("catalog_read_failed", error.message);
  const rows = (data ?? []) as CapabilityRow[];
  if (rows.length === 0) return { capabilities: [] };

  const ids = rows.map((row) => row.id);
  const versionIds = rows.flatMap((row) => (row.current_version_id ? [row.current_version_id] : []));
  const [connections, versions, grants] = await Promise.all([
    sb.from("capability_connections")
      .select("capability_id,auth_type,endpoint_url,enabled")
      .eq("workspace_id", actor.workspaceId)
      .eq("environment", "production")
      .in("capability_id", ids),
    versionIds.length > 0
      ? sb.from("capability_versions").select("id,contract").eq("workspace_id", actor.workspaceId).in("id", versionIds)
      : Promise.resolve({ data: [], error: null }),
    sb.from("capability_grants")
      .select("id,capability_id,principal_id,actions,constraints,expires_at")
      .eq("workspace_id", actor.workspaceId)
      .in("capability_id", ids)
      .is("revoked_at", null),
  ]);
  const connectionBy = new Map(
    ((connections.data ?? []) as Array<{ capability_id: string; auth_type: string; endpoint_url: string; enabled: boolean }>)
      .map((row) => [row.capability_id, row]),
  );
  const toolsByVersion = new Map(
    ((versions.data ?? []) as Array<{ id: string; contract: unknown }>).map((row) => [row.id, contractToolNames(row.contract)]),
  );
  const grantsBy = new Map<string, number>();
  for (const grant of (grants.data ?? []) as Array<{ capability_id: string }>) {
    grantsBy.set(grant.capability_id, (grantsBy.get(grant.capability_id) ?? 0) + 1);
  }
  const me = await selfPrincipalId(actor);
  const mine = new Set(
    ((grants.data ?? []) as Array<{ capability_id: string; principal_id: string }>)
      .filter((grant) => me && grant.principal_id === me)
      .map((grant) => grant.capability_id),
  );

  return {
    capabilities: rows.map((row) => {
      const connection = connectionBy.get(row.id);
      return {
        id: row.id,
        key: row.key,
        type: row.type,
        provider: row.provider,
        title: row.title,
        description: row.description,
        status: row.status,
        updated_at: row.updated_at,
        connection: connection
          ? { auth_type: connection.auth_type, endpoint_host: hostOf(connection.endpoint_url), enabled: connection.enabled }
          : null,
        tools: row.current_version_id ? toolsByVersion.get(row.current_version_id) ?? [] : [],
        active_grants: grantsBy.get(row.id) ?? 0,
        granted_to_me: mine.has(row.id),
      };
    }),
  };
}

/** `capabilities(op=discover)`: what an endpoint offers, before anything is stored. */
export async function discoverCapability(
  actor: CapabilityAdminActor,
  input: z.infer<typeof DiscoverCapabilityInput>,
) {
  const userId = requireUser(actor);
  const connection = connectionInput(input);
  const result = await discoverProviderTools({
    workspaceId: actor.workspaceId,
    userId,
    connection,
    actor: { actorType: "agent", agentTokenId: actor.tokenId },
  }).catch(rethrowDiscovery);
  return {
    provider: { name: result.provider.name, title: result.provider.title, description: result.provider.description },
    logo_url: result.logo_url,
    truncated: result.truncated,
    tools: result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      ...(input.include_schemas ? { inputSchema: tool.inputSchema } : {}),
    })),
  };
}

/**
 * `capabilities(op=status)`: with `attempt_id`, the OAuth attempt an agent is
 * polling (or cancelling); otherwise one capability's health and grants.
 */
export async function capabilityStatus(
  actor: CapabilityAdminActor,
  input: z.infer<typeof CapabilityStatusInput>,
) {
  if (input.attempt_id) {
    const userId = requireUser(actor);
    const args = { workspaceId: actor.workspaceId, userId, attemptId: input.attempt_id };
    const attempt = await (input.cancel ? cancelOAuthAttempt(args) : getOAuthAttemptStatus(args)).catch(rethrowOAuth);
    return {
      attempt: {
        id: attempt.id,
        status: attempt.status,
        endpoint_url: attempt.endpointUrl,
        scopes: attempt.scopes,
        expires_at: attempt.expiresAt,
        connected_at: attempt.connectedAt,
        error_code: attempt.errorCode,
      },
      next: attempt.status === "authorized"
        ? "Call capabilities_write(op=connect) with auth {type:'oauth', attempt_id} to register the provider."
        : attempt.status === "pending"
          ? "Waiting for a person to consent at authorization_url; poll again."
          : "This attempt is finished; start a new connect to get a fresh authorization_url.",
    };
  }
  if (!input.capability_id) {
    throw new CapabilityAdminError("invalid_request", "pass capability_id or attempt_id");
  }
  requireDb();
  const sb = getSupabaseAdmin();
  const { data: capability, error } = await sb
    .from("capabilities")
    .select("id,key,type,provider,title,description,status,current_version_id,disabled_at,updated_at")
    .eq("workspace_id", actor.workspaceId)
    .eq("id", input.capability_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new CapabilityAdminError("catalog_read_failed", error.message);
  if (!capability) throw new CapabilityAdminError("capability_not_found", "capability not found in this workspace");
  const [{ data: connection }, { data: version }, { data: grants }, credentialUsable] = await Promise.all([
    sb.from("capability_connections")
      .select("id,auth_type,endpoint_url,allowed_hosts,timeout_ms,enabled,updated_at")
      .eq("workspace_id", actor.workspaceId)
      .eq("capability_id", capability.id)
      .eq("environment", "production")
      .maybeSingle(),
    capability.current_version_id
      ? sb.from("capability_versions").select("id,version,contract").eq("workspace_id", actor.workspaceId).eq("id", capability.current_version_id).maybeSingle()
      : Promise.resolve({ data: null }),
    sb.from("capability_grants")
      .select("id,principal_id,actions,constraints,expires_at,capability_principals(kind,source_type,source_id,display_name)")
      .eq("workspace_id", actor.workspaceId)
      .eq("capability_id", capability.id)
      .is("revoked_at", null),
    capabilityCredentialUsable(actor.workspaceId, capability.id),
  ]);
  return {
    capability: {
      ...capability,
      connection: connection
        ? {
            id: connection.id,
            auth_type: connection.auth_type,
            endpoint_url: connection.endpoint_url,
            allowed_hosts: connection.allowed_hosts,
            timeout_ms: connection.timeout_ms,
            enabled: connection.enabled,
            credential_usable: credentialUsable,
          }
        : null,
      version: version ? { id: version.id, version: version.version, tools: contractToolNames(version.contract) } : null,
      grants: ((grants ?? []) as Array<Record<string, unknown>>).map((grant) => ({
        id: grant.id,
        principal_id: grant.principal_id,
        principal: grant.capability_principals ?? null,
        actions: grant.actions,
        constraints: grant.constraints,
        expires_at: grant.expires_at,
      })),
    },
  };
}

// ---- Writes ---------------------------------------------------------------

export async function connectCapability(
  actor: CapabilityAdminActor,
  input: z.infer<typeof ConnectCapabilityInput>,
) {
  requireDb();
  const userId = requireUser(actor);
  const endpoint = new URL(input.endpoint_url);
  // Pinned to the endpoint host, as the UI's provider update does: the MCP
  // input does not widen egress.
  const allowedHosts = [endpoint.hostname];

  // OAuth, first leg: no attempt yet → hand the authorization URL back. A
  // person consents in a browser; the agent polls status and comes back with
  // the attempt id. Nothing is registered until then.
  if (input.auth.type === "oauth" && !input.auth.attempt_id) {
    if (input.type !== "mcp_server") {
      throw new CapabilityAdminError("oauth_mcp_only", "managed OAuth is supported only for mcp_server capabilities");
    }
    const started = await startOAuthAuthorization({
      workspaceId: actor.workspaceId,
      userId,
      endpointUrl: input.endpoint_url,
      allowedHosts,
      appOrigin: canonicalAppOrigin(),
    }).catch(rethrowOAuth);
    return {
      status: "authorization_required" as const,
      attempt_id: started.attemptId,
      authorization_url: started.authorizationUrl,
      authorization_host: new URL(started.authorizationUrl).hostname,
      expires_at: started.expiresAt,
      scopes: started.scopes,
      next: "A person opens authorization_url and consents. Poll capabilities(op=status, attempt_id) until status is 'authorized', then call connect again with the same key and auth {type:'oauth', attempt_id}.",
    };
  }

  const connection = connectionInput(input);
  let contract: Record<string, unknown>;
  let provider = input.provider;
  let title = input.title;
  let description = input.description;
  let discoveredCount = 0;
  if (input.type === "mcp_server") {
    const discovered = await discoverProviderTools({
      workspaceId: actor.workspaceId,
      userId,
      connection,
      actor: { actorType: "agent", agentTokenId: actor.tokenId },
    }).catch(rethrowDiscovery);
    discoveredCount = discovered.tools.length;
    const wanted = input.tools ? new Set(input.tools) : null;
    const tools = wanted ? discovered.tools.filter((tool) => wanted.has(tool.name)) : discovered.tools;
    if (wanted) {
      const missing = [...wanted].filter((name) => !discovered.tools.some((tool) => tool.name === name));
      if (missing.length > 0) {
        throw new CapabilityAdminError(
          "tools_not_found",
          `the provider does not expose: ${missing.join(", ")} (it has: ${discovered.tools.map((t) => t.name).join(", ")})`,
        );
      }
    }
    contract = { protocol: "mcp_streamable_http", tools };
    provider ??= discovered.provider.name;
    title ??= discovered.provider.title;
    description ??= discovered.provider.description;
  } else {
    if (!input.contract) {
      throw new CapabilityAdminError("contract_required", `${input.type} capabilities need a webhook contract`);
    }
    contract = input.contract;
    provider ??= endpoint.hostname;
    title ??= input.key;
  }

  const registration = RegisterCapabilityInputSchema.safeParse({
    workspace_id: actor.workspaceId,
    key: input.key,
    type: input.type,
    provider,
    title,
    description: description ?? "",
    provenance: {
      source: "mcp",
      token_id: actor.tokenId,
      ...(actor.agentId ? { agent_id: actor.agentId } : {}),
      endpoint_host: endpoint.hostname,
    },
    environment: "production",
    contract,
    status: input.status,
    connection,
  });
  if (!registration.success) {
    throw new CapabilityAdminError("invalid_request", registration.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  const reg = registration.data;
  const digest = await sha256Hex(stableJson(reg.contract));
  const sb = getSupabaseAdmin();

  let capabilityId: string;
  let versionId: string;
  let created = true;
  if (reg.connection?.authType === "oauth") {
    const result = await registerOAuthCapability({
      workspaceId: actor.workspaceId,
      userId,
      attemptId: reg.connection.oauthAttemptId!,
      expectedEndpointUrl: reg.connection.endpointUrl,
      key: reg.key,
      provider: reg.provider,
      title: reg.title,
      description: reg.description,
      provenance: reg.provenance,
      environment: reg.environment,
      contract: reg.contract,
      contractDigest: digest,
      changeSummary: null,
      status: reg.status,
      timeoutMs: reg.connection.timeoutMs,
    }).catch(rethrowOAuth);
    capabilityId = result.capabilityId;
    versionId = result.versionId;
    created = result.created;
  } else {
    // Vault first, as the REST route does: a token that cannot be stored
    // registers nothing, and a write that fails before the connection row
    // takes the reference discards it.
    let secretRef: string | null = null;
    if (reg.connection?.secret) {
      secretRef = await storeConnectionSecret({ workspaceId: actor.workspaceId, plaintext: reg.connection.secret })
        .catch((error: unknown) => {
          if (error instanceof ConnectionSecretError) throw new CapabilityAdminError(error.code, error.message);
          throw error;
        });
    }
    const refused = async (code: string, message: string) => {
      await discardConnectionSecret(secretRef);
      return new CapabilityAdminError(code, message);
    };
    // Same three inserts as POST /api/capabilities, through the admin client:
    // the caller was already checked for the admin verb on its grant.
    const { data: capability, error: capabilityError } = await sb
      .from("capabilities")
      .insert({
        workspace_id: actor.workspaceId,
        key: reg.key,
        type: reg.type,
        owner_user_id: userId,
        provider: reg.provider,
        title: reg.title,
        description: reg.description,
        provenance: reg.provenance,
        status: "draft",
      })
      .select("id")
      .single();
    if (capabilityError || !capability) {
      const duplicate = capabilityError?.code === "23505";
      throw await refused(
        duplicate ? "capability_exists" : "catalog_write_failed",
        duplicate ? `a capability with key "${reg.key}" already exists; disconnect it first or pick another key` : capabilityError?.message ?? "no row",
      );
    }
    capabilityId = capability.id as string;
    const { data: version, error: versionError } = await sb
      .from("capability_versions")
      .insert({
        workspace_id: actor.workspaceId,
        capability_id: capabilityId,
        version: 1,
        environment: reg.environment,
        contract: reg.contract,
        contract_digest: digest,
        change_summary: null,
        created_by: userId,
      })
      .select("id")
      .single();
    if (versionError || !version) throw await refused("version_write_failed", versionError?.message ?? "no row");
    versionId = version.id as string;
    if (reg.connection) {
      const { error } = await sb.from("capability_connections").insert({
        workspace_id: actor.workspaceId,
        capability_id: capabilityId,
        environment: reg.environment,
        endpoint_url: reg.connection.endpointUrl,
        auth_type: reg.connection.authType,
        auth_header_name: reg.connection.authHeaderName ?? null,
        secret_ref: secretRef,
        allowed_hosts: reg.connection.allowedHosts,
        timeout_ms: reg.connection.timeoutMs,
      });
      if (error) throw await refused("connection_write_failed", error.message);
    }
    const { error: finalizeError } = await sb
      .from("capabilities")
      .update({ current_version_id: versionId, status: reg.status, disabled_at: null })
      .eq("id", capabilityId)
      .eq("workspace_id", actor.workspaceId);
    if (finalizeError) throw new CapabilityAdminError("catalog_finalize_failed", finalizeError.message);
  }

  void appendAudit({
    workspaceId: actor.workspaceId,
    actorType: "agent",
    actorId: userId,
    agentTokenId: actor.tokenId,
    action: created ? "capability.create" : "capability.create.replayed",
    targetType: "capability",
    targetId: capabilityId,
    input: { key: reg.key, type: reg.type, provider: reg.provider, status: reg.status, version_id: versionId, via: "mcp" },
  });
  const toolNames = contractToolNames(reg.contract);
  return {
    status: "connected" as const,
    capability: { id: capabilityId, key: reg.key, type: reg.type, provider: reg.provider, title: reg.title, status: reg.status },
    version_id: versionId,
    tools: toolNames,
    ...(discoveredCount > toolNames.length ? { discovered: discoveredCount } : {}),
    next: "Nobody can call it yet: grants are explicit. capabilities_write(op=grant, capability_id) grants the calling principal; pass principal to grant someone else, allowed_tools to narrow it.",
  };
}

/** `capabilities_write(op=disconnect)`: revoke every grant and tombstone the row via RPC. */
export async function disconnectCapability(
  actor: CapabilityAdminActor,
  input: z.infer<typeof DisconnectCapabilityInput>,
) {
  requireDb();
  const userId = requireUser(actor);
  const { data, error } = await getSupabaseAdmin().rpc("remove_capability_provider", {
    p_workspace_id: actor.workspaceId,
    p_user_id: userId,
    p_capability_id: input.capability_id,
    p_expected_updated_at: input.expected_updated_at ?? null,
  }).single();
  if (error || !data) throw providerMutationError(error);
  const result = data as { capability_id: string; grants_revoked: number; already_removed: boolean };
  void appendAudit({
    workspaceId: actor.workspaceId,
    actorType: "agent",
    actorId: userId,
    agentTokenId: actor.tokenId,
    action: "capability.delete",
    targetType: "capability",
    targetId: input.capability_id,
    output: { grants_revoked: result.grants_revoked, already_removed: result.already_removed, via: "mcp" },
  });
  return { ok: true, ...result, history_preserved: true };
}

/**
 * `capabilities_write(op=grant)`: discover+invoke for a principal (the
 * caller by default), optionally narrowed with `allowed_tools`, which must
 * name tools in the current contract.
 */
export async function grantCapability(
  actor: CapabilityAdminActor,
  input: z.infer<typeof GrantCapabilityInput>,
) {
  requireDb();
  const sb = getSupabaseAdmin();
  const { data: target, error: targetError } = await sb
    .from("capabilities")
    .select("id,status,current_version_id")
    .eq("workspace_id", actor.workspaceId)
    .eq("id", input.capability_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (targetError) throw new CapabilityAdminError("catalog_read_failed", targetError.message);
  if (!target) throw new CapabilityAdminError("capability_not_found", "capability not found in this workspace");

  if (input.allowed_tools && target.current_version_id) {
    const { data: version } = await sb
      .from("capability_versions")
      .select("contract")
      .eq("workspace_id", actor.workspaceId)
      .eq("id", target.current_version_id)
      .maybeSingle();
    const known = new Set(contractToolNames(version?.contract));
    const unknown = input.allowed_tools.filter((name) => !known.has(name));
    if (known.size > 0 && unknown.length > 0) {
      throw new CapabilityAdminError("tools_not_found", `not in this capability's contract: ${unknown.join(", ")}`);
    }
  }

  const principalId = input.principal
    ? await resolvePrincipal(actor, input.principal)
    : await ensureSelfPrincipal(actor);
  const { data: grant, error: grantError } = await sb
    .from("capability_grants")
    .insert({
      workspace_id: actor.workspaceId,
      principal_id: principalId,
      capability_id: input.capability_id,
      bundle_id: null,
      actions: ["discover", "invoke"],
      constraints: input.allowed_tools ? { allowed_tools: input.allowed_tools } : {},
      expires_at: input.expires_at ?? null,
      created_by: actor.userId,
    })
    .select("id,actions,constraints,expires_at")
    .single();
  if (grantError || !grant) throw new CapabilityAdminError("grant_write_failed", grantError?.message ?? "no row");
  void appendAudit({
    workspaceId: actor.workspaceId,
    actorType: "agent",
    actorId: actor.userId,
    agentTokenId: actor.tokenId,
    action: "capability.grant.create",
    targetType: "capability_grant",
    targetId: grant.id as string,
    input: { principal_id: principalId, capability_id: input.capability_id, actions: ["discover", "invoke"], via: "mcp" },
  });
  return {
    grant: { id: grant.id, principal_id: principalId, capability_id: input.capability_id, actions: grant.actions, constraints: grant.constraints, expires_at: grant.expires_at },
    ...(target.status !== "approved"
      ? { note: `the capability is ${target.status}; its tools appear in tools/list only once it is approved` }
      : {}),
  };
}

/** `capabilities_write(op=revoke)`: soft-revoke one grant; history stays for audit. */
export async function revokeCapabilityGrant(
  actor: CapabilityAdminActor,
  input: z.infer<typeof RevokeCapabilityGrantInput>,
) {
  requireDb();
  const { data, error } = await getSupabaseAdmin()
    .from("capability_grants")
    .update({ revoked_at: new Date().toISOString() })
    .eq("workspace_id", actor.workspaceId)
    .eq("id", input.grant_id)
    .is("revoked_at", null)
    .select("id");
  if (error) throw new CapabilityAdminError("grant_write_failed", error.message);
  const revoked = (data ?? []).length > 0;
  if (revoked) {
    void appendAudit({
      workspaceId: actor.workspaceId,
      actorType: "agent",
      actorId: actor.userId,
      agentTokenId: actor.tokenId,
      action: "capability.grant.revoke",
      targetType: "capability_grant",
      targetId: input.grant_id,
      input: { via: "mcp" },
    });
  }
  return { ok: true, revoked, grant_id: input.grant_id };
}

// ---- Principals -----------------------------------------------------------

/** The same (source_type, source_id) the catalog resolves the caller by. */
function selfSource(actor: CapabilityAdminActor): { kind: "user" | "agent"; sourceType: "agent" | "user" | "agent_token"; sourceId: string | null } {
  if (actor.agentId) return { kind: "agent", sourceType: "agent", sourceId: actor.agentId };
  if (actor.tokenScope === "user") return { kind: "user", sourceType: "user", sourceId: actor.userId };
  return { kind: "agent", sourceType: "agent_token", sourceId: actor.tokenId };
}

async function selfPrincipalId(actor: CapabilityAdminActor): Promise<string | null> {
  const self = selfSource(actor);
  if (!self.sourceId) return null;
  const { data } = await getSupabaseAdmin()
    .from("capability_principals")
    .select("id")
    .eq("workspace_id", actor.workspaceId)
    .eq("source_type", self.sourceType)
    .eq("source_id", self.sourceId)
    .maybeSingle();
  return data ? (data.id as string) : null;
}

async function ensureSelfPrincipal(actor: CapabilityAdminActor): Promise<string> {
  const self = selfSource(actor);
  if (!self.sourceId) throw new CapabilityAdminError("principal_unresolvable", "this token has no principal to grant");
  return upsertPrincipal(actor.workspaceId, {
    kind: self.kind,
    sourceType: self.sourceType,
    sourceId: self.sourceId,
    displayName: actor.agentLabel ?? (self.kind === "user" ? "user" : "agent token"),
  });
}

async function resolvePrincipal(
  actor: CapabilityAdminActor,
  principal: { kind: "user" | "agent" | "service_account"; id: string; display_name?: string },
): Promise<string> {
  if (principal.kind === "service_account") {
    // A service account IS a capability_principals row; its id is the row id.
    const { data } = await getSupabaseAdmin()
      .from("capability_principals")
      .select("id")
      .eq("workspace_id", actor.workspaceId)
      .eq("id", principal.id)
      .is("disabled_at", null)
      .maybeSingle();
    if (!data) throw new CapabilityAdminError("principal_not_found", "service account principal not found in this workspace");
    return data.id as string;
  }
  return upsertPrincipal(actor.workspaceId, {
    kind: principal.kind,
    sourceType: principal.kind,
    sourceId: principal.id,
    displayName: principal.display_name ?? `${principal.kind} ${principal.id.slice(0, 8)}`,
  });
}

async function upsertPrincipal(
  workspaceId: string,
  input: { kind: "user" | "agent"; sourceType: "user" | "agent" | "agent_token"; sourceId: string; displayName: string },
): Promise<string> {
  const { data, error } = await getSupabaseAdmin()
    .from("capability_principals")
    .upsert({
      workspace_id: workspaceId,
      kind: input.kind,
      source_type: input.sourceType,
      source_id: input.sourceId,
      display_name: input.displayName,
      disabled_at: null,
    }, { onConflict: "workspace_id,source_type,source_id" })
    .select("id")
    .single();
  if (error || !data) throw new CapabilityAdminError("principal_write_failed", error?.message ?? "no row");
  return data.id as string;
}

// ---- Helpers --------------------------------------------------------------

function connectionInput(input: z.infer<typeof EndpointInput>): z.infer<typeof CapabilityConnectionInputSchema> {
  const endpoint = new URL(input.endpoint_url);
  const parsed = CapabilityConnectionInputSchema.safeParse({
    endpointUrl: input.endpoint_url,
    authType: input.auth.type,
    ...(input.auth.header_name ? { authHeaderName: input.auth.header_name } : {}),
    ...(input.auth.secret ? { secret: input.auth.secret } : {}),
    ...(input.auth.attempt_id ? { oauthAttemptId: input.auth.attempt_id } : {}),
    allowedHosts: [endpoint.hostname],
    timeoutMs: input.timeout_ms,
  });
  if (!parsed.success) {
    throw new CapabilityAdminError("invalid_request", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return parsed.data;
}

function contractToolNames(contract: unknown): string[] {
  const parsed = ExecutableContractSchema.safeParse(contract);
  if (!parsed.success) return [];
  return parsed.data.protocol === "mcp_streamable_http"
    ? parsed.data.tools.map((tool) => tool.name)
    : [parsed.data.tool.name];
}

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

function requireDb(): void {
  if (!supabaseConfigured()) {
    throw new CapabilityAdminError("catalog_unavailable", "the capability catalog needs a persisted workspace (no Supabase configured)");
  }
}

function requireUser(actor: CapabilityAdminActor): string {
  if (!actor.userId) {
    throw new CapabilityAdminError(
      "user_attribution_required",
      "this token is not attributed to a person; capability changes need a token created by a workspace owner or admin",
    );
  }
  return actor.userId;
}

function canonicalAppOrigin(): string {
  const configured = configuredAppUrl();
  if (!configured) throw new CapabilityAdminError("oauth_origin_unavailable", "OAuth is not configured on this Bcontext deployment");
  const url = new URL(configured);
  if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new CapabilityAdminError("oauth_origin_invalid", "OAuth callback origin must use HTTPS");
  }
  return url.origin;
}

function rethrowOAuth(error: unknown): never {
  if (error instanceof CapabilityOAuthError) throw new CapabilityAdminError(error.code, error.message);
  throw error;
}

function rethrowDiscovery(error: unknown): never {
  if (error instanceof CapabilityDiscoveryError) throw new CapabilityAdminError(error.code, error.message);
  throw error;
}

function providerMutationError(error: { message?: string } | null): CapabilityAdminError {
  const message = error?.message ?? "";
  const known: Array<[string, string, string]> = [
    ["capability_admin_required", "capability_admin_required", "the attributed user is not an owner or admin of this workspace"],
    ["capability_provider_not_found", "capability_not_found", "capability not found in this workspace"],
    ["capability_provider_not_executable", "capability_not_executable", "only mcp_server, api and workflow capabilities can be disconnected"],
    ["capability_provider_stale", "capability_stale", "the capability changed since you read it; re-read and retry with the new expected_updated_at"],
    ["capability_provider_used_by_bundle", "provider_used_by_bundle", "this capability is pinned by a current bundle"],
    ["capability_provider_remove_raced", "capability_stale", "another change raced this disconnect; re-read and retry"],
  ];
  for (const [needle, code, text] of known) {
    if (message.includes(needle)) return new CapabilityAdminError(code, text);
  }
  return new CapabilityAdminError("catalog_write_failed", message || "capability mutation failed");
}
