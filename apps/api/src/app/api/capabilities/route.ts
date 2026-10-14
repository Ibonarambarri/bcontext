/**
 * The capability catalog of a workspace — external tools (MCP servers, APIs,
 * workflows…) an agent may be granted — as the Connections page edits it.
 *
 *   GET   /api/capabilities?workspace_id=…&surface=providers&type=&status=&q=
 *   POST  /api/capabilities     register: row + version 1 + optional connection
 *   PATCH /api/capabilities     status change (draft/approved/deprecated/disabled)
 *
 * Session-cookie owner|admin of the workspace (`capabilityAdmin`); reads go
 * through the caller's RLS client. An OAuth-backed registration is handed to
 * `registerOAuthCapability`, which attaches the credential from the finished
 * authorize attempt in the same transaction. Approving an executable type
 * needs a usable credential — the gate `capabilityCredentialUsable` shares
 * with the review route — and a provider pinned by a current bundle cannot
 * be disabled (the DB raises, mapped to 409). A pasted bearer/header token
 * goes to Vault first (`storeConnectionSecret`) and only its reference is
 * written; no response or audit row carries the token.
 */
import { z } from "zod";
import { appendAudit, stableJson, sha256Hex } from "@/lib/audit";
import { withRoute } from "@/lib/route";
import { capabilityAdmin, capabilityCredentialUsable, parseJson } from "@/lib/capabilities/admin";
import {
  RegisterCapabilityInputSchema,
  UpdateCapabilityInputSchema,
} from "@/lib/capabilities/admin-schemas";
import { ConnectionSecretError, discardConnectionSecret, storeConnectionSecret } from "@/lib/capabilities/connection-secret";
import { CapabilityOAuthError, registerOAuthCapability } from "@/lib/capabilities/oauth";

const CAPABILITY_TYPES = ["mcp_server", "api", "workflow", "skill", "plugin", "script_or_cli", "agent"] as const;
const CAPABILITY_STATUSES = ["draft", "approved", "deprecated", "disabled"] as const;
const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;

export const GET = withRoute(async (req: Request) => {
  const requestUrl = new URL(req.url);
  const workspaceId = requestUrl.searchParams.get("workspace_id");
  const surface = requestUrl.searchParams.get("surface");
  if (!workspaceId || !z.string().uuid().safeParse(workspaceId).success) {
    return Response.json({ error: "invalid_request", message: "workspace_id (uuid) is required" }, { status: 400 });
  }
  const auth = await capabilityAdmin(req, workspaceId);
  if (auth instanceof Response) return auth;
  if (surface && surface !== "providers") {
    return Response.json({ error: "invalid_request", message: "unknown capability surface" }, { status: 400 });
  }

  const typeParam = requestUrl.searchParams.get("type");
  if (typeParam && !CAPABILITY_TYPES.includes(typeParam as (typeof CAPABILITY_TYPES)[number])) {
    return Response.json({ error: "invalid_request", message: `unknown capability type: ${typeParam}` }, { status: 400 });
  }
  const statusParam = requestUrl.searchParams.get("status");
  if (statusParam && !CAPABILITY_STATUSES.includes(statusParam as (typeof CAPABILITY_STATUSES)[number])) {
    return Response.json({ error: "invalid_request", message: `unknown capability status: ${statusParam}` }, { status: 400 });
  }
  const q = requestUrl.searchParams.get("q")?.trim();
  const limitParam = requestUrl.searchParams.get("limit");
  const limit = limitParam ? Math.min(Math.max(Number.parseInt(limitParam, 10) || DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT) : DEFAULT_LIST_LIMIT;
  const offsetParam = requestUrl.searchParams.get("offset");
  const offset = offsetParam ? Math.max(Number.parseInt(offsetParam, 10) || 0, 0) : 0;

  let query = auth.supabase
    .from("capabilities")
    .select("id,key,type,provider,title,description,provenance,status,current_version_id,disabled_at,deleted_at,created_at,updated_at", { count: "exact" })
    .eq("workspace_id", workspaceId)
    .is("deleted_at", null);
  if (surface === "providers") query = query.in("type", ["mcp_server", "workflow"]);
  if (typeParam) query = query.eq("type", typeParam);
  if (statusParam) query = query.eq("status", statusParam);
  if (q) {
    // Intent search over the fields an admin would recognize a provider by;
    // "team"/"permission" filters are not modeled on `capabilities` yet
    // (no team or tags column), so those remain out of scope until that
    // dimension exists on the catalog.
    const escaped = q.replace(/[%_]/g, (match) => `\\${match}`);
    query = query.or(
      `title.ilike.%${escaped}%,description.ilike.%${escaped}%,provider.ilike.%${escaped}%,key.ilike.%${escaped}%`,
    );
  }
  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) return Response.json({ error: "internal", message: error.message }, { status: 500 });
  return Response.json({ capabilities: data ?? [], total: count ?? (data ?? []).length, limit, offset });
});

export const POST = withRoute(async (req: Request) => {
  const input = await parseJson(req, RegisterCapabilityInputSchema);
  if (input instanceof Response) return input;
  const auth = await capabilityAdmin(req, input.workspace_id);
  if (auth instanceof Response) return auth;
  const sb = auth.supabase;
  const digest = await sha256Hex(stableJson(input.contract));

  if (input.connection?.authType === "oauth") {
    let registration;
    try {
      registration = await registerOAuthCapability({
        workspaceId: input.workspace_id,
        userId: auth.userId,
        attemptId: input.connection.oauthAttemptId!,
        expectedEndpointUrl: input.connection.endpointUrl,
        key: input.key,
        provider: input.provider,
        title: input.title,
        description: input.description,
        provenance: input.provenance,
        environment: input.environment,
        contract: input.contract,
        contractDigest: digest,
        changeSummary: input.change_summary ?? null,
        status: input.status,
        timeoutMs: input.connection.timeoutMs,
      });
    } catch (error) {
      const known = error instanceof CapabilityOAuthError ? error : null;
      return Response.json({
        error: known?.code ?? "oauth_register_failed",
        message: known?.message ?? "Unable to register the authorized provider",
      }, { status: known?.httpStatus ?? 500 });
    }

    const { data: registeredCapability, error: readError } = await sb
      .from("capabilities")
      .select("*")
      .eq("workspace_id", input.workspace_id)
      .eq("id", registration.capabilityId)
      .is("deleted_at", null)
      .single();
    if (readError || !registeredCapability) {
      return Response.json({
        error: "catalog_read_failed",
        message: readError?.message ?? "registered capability could not be read",
        capability_id: registration.capabilityId,
      }, { status: 500 });
    }
    if (registration.created) {
      void appendAudit({
        workspaceId: input.workspace_id,
        actorType: "user",
        actorId: auth.userId,
        action: "capability.create",
        targetType: "capability",
        targetId: registration.capabilityId,
        input: {
          key: input.key,
          type: input.type,
          provider: input.provider,
          status: input.status,
          version_id: registration.versionId,
        },
      });
    }
    return Response.json({
      capability: registeredCapability,
      version_id: registration.versionId,
    }, { status: registration.created ? 201 : 200 });
  }

  // Vault first: if the credential cannot be stored nothing else is written,
  // and a later failure discards the reference so no orphan is left behind.
  let secretRef: string | null = null;
  if (input.connection?.secret) {
    try {
      secretRef = await storeConnectionSecret({ workspaceId: input.workspace_id, plaintext: input.connection.secret });
    } catch (error) {
      if (error instanceof ConnectionSecretError) {
        return Response.json({ error: error.code, message: error.message }, { status: 503 });
      }
      throw error;
    }
  }
  const failed = async (body: Record<string, unknown>, status: number) => {
    await discardConnectionSecret(secretRef);
    return Response.json(body, { status });
  };

  const { data: capability, error: capabilityError } = await sb
    .from("capabilities")
    .insert({
      workspace_id: input.workspace_id,
      key: input.key,
      type: input.type,
      owner_user_id: auth.userId,
      provider: input.provider,
      title: input.title,
      description: input.description,
      provenance: input.provenance,
      status: "draft",
    })
    .select("id")
    .single();
  if (capabilityError || !capability) {
    return failed({ error: "catalog_write_failed", message: capabilityError?.message ?? "no row" }, 409);
  }
  const { data: version, error: versionError } = await sb
    .from("capability_versions")
    .insert({
      workspace_id: input.workspace_id,
      capability_id: capability.id,
      version: 1,
      environment: input.environment,
      contract: input.contract,
      contract_digest: digest,
      change_summary: input.change_summary ?? null,
      created_by: auth.userId,
    })
    .select("id")
    .single();
  if (versionError || !version) {
    return failed({ error: "version_write_failed", message: versionError?.message ?? "no row", capability_id: capability.id }, 500);
  }
  if (input.connection) {
    const connection = input.connection;
    const { error } = await sb.from("capability_connections").insert({
      workspace_id: input.workspace_id,
      capability_id: capability.id,
      environment: input.environment,
      endpoint_url: connection.endpointUrl,
      auth_type: connection.authType,
      auth_header_name: connection.authHeaderName ?? null,
      secret_ref: secretRef,
      allowed_hosts: connection.allowedHosts,
      timeout_ms: connection.timeoutMs,
    });
    if (error) {
      return failed({ error: "connection_write_failed", message: error.message, capability_id: capability.id }, 500);
    }
  }
  const { data: updated, error: updateError } = await sb
    .from("capabilities")
    .update({
      current_version_id: version.id,
      status: input.status,
      disabled_at: null,
    })
    .eq("id", capability.id)
    .eq("workspace_id", input.workspace_id)
    .is("deleted_at", null)
    .select("*")
    .single();
  if (updateError || !updated) {
    return Response.json({ error: "catalog_finalize_failed", message: updateError?.message ?? "no row", capability_id: capability.id }, { status: 500 });
  }
  void appendAudit({
    workspaceId: input.workspace_id,
    actorType: "user",
    actorId: auth.userId,
    action: "capability.create",
    targetType: "capability",
    targetId: capability.id,
    input: { key: input.key, type: input.type, provider: input.provider, status: input.status, version_id: version.id },
  });
  return Response.json({ capability: updated, version_id: version.id }, { status: 201 });
});

export const PATCH = withRoute(async (req: Request) => {
  const input = await parseJson(req, UpdateCapabilityInputSchema);
  if (input instanceof Response) return input;
  const auth = await capabilityAdmin(req, input.workspace_id);
  if (auth instanceof Response) return auth;
  const { data: current } = await auth.supabase
    .from("capabilities")
    .select("id,type")
    .eq("workspace_id", input.workspace_id)
    .eq("id", input.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!current) return Response.json({ error: "capability_not_found" }, { status: 404 });

  if (input.status === "approved" && ["mcp_server", "api", "workflow"].includes(current.type)) {
    const credentialUsable = await capabilityCredentialUsable(input.workspace_id, input.id);
    if (!credentialUsable) {
      return Response.json({
        error: "provider_reconnect_required",
        message: "Reconnect this provider before enabling it.",
      }, { status: 409 });
    }
  }
  const disabled = input.status === "disabled";
  const { data, error } = await auth.supabase
    .from("capabilities")
    .update({ status: input.status, disabled_at: disabled ? new Date().toISOString() : null })
    .eq("workspace_id", input.workspace_id)
    .eq("id", input.id)
    .is("deleted_at", null)
    .select("*")
    .single();
  if (error || !data) {
    const usedByBundle = error?.message.includes("capability_provider_used_by_bundle");
    return Response.json({
      error: usedByBundle ? "provider_used_by_bundle" : "catalog_update_failed",
      message: usedByBundle ? "This provider is pinned by a current bundle." : error?.message ?? "not found",
    }, { status: usedByBundle ? 409 : 404 });
  }
  void appendAudit({
    workspaceId: input.workspace_id,
    actorType: "user",
    actorId: auth.userId,
    action: "capability.status.update",
    targetType: "capability",
    targetId: input.id,
    input: { status: input.status },
  });
  return Response.json({ capability: data });
});
