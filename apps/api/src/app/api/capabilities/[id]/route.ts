/**
 * One provider of the capability catalog, as the Connections page edits it.
 *
 *   GET    /api/capabilities/:id?workspace_id=…        capability + version + connection
 *   PATCH  /api/capabilities/:id                        contract, endpoint, auth, credential
 *   DELETE /api/capabilities/:id?workspace_id=…&expected_updated_at=
 *
 * Session-cookie owner|admin (`capabilityAdmin`). Mutations go through the
 * `update_capability_provider` / `remove_capability_provider` RPCs so the new
 * version, the connection, the credential decision and the grant revocations
 * commit together; `expected_updated_at` is the optimistic lock, a stale one
 * is 409. A replaced bearer/header token is stored in Vault before the RPC
 * and only its reference is passed; the database drops the previous Vault
 * entry when the reference changes or the connection row goes. Deleting is
 * a soft delete — history stays readable. A `logo_url`
 * in provenance only survives when it is https on a host the endpoint's
 * brand owns, so a provider cannot wear another provider's logo.
 */
import { z } from "zod";
import { appendAudit, sha256Hex, stableJson } from "@/lib/audit";
import { capabilityAdmin, parseJson } from "@/lib/capabilities/admin";
import { UpdateCapabilityProviderInputSchema } from "@/lib/capabilities/admin-schemas";
import { ConnectionSecretError, discardConnectionSecret, storeConnectionSecret } from "@/lib/capabilities/connection-secret";
import { providerBrandHosts } from "@/lib/capabilities/provider-brand";
import { withRoute } from "@/lib/route";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

const ParamsSchema = z.object({ id: z.string().uuid() });
const WorkspaceSchema = z.string().uuid();

type AdminClient = ReturnType<typeof getSupabaseAdmin>;

export const GET = withRoute(async (
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) => {
  const params = ParamsSchema.safeParse(await ctx.params);
  const workspaceId = new URL(req.url).searchParams.get("workspace_id");
  if (!params.success || !workspaceId || !WorkspaceSchema.safeParse(workspaceId).success) {
    return Response.json({ error: "invalid_request", message: "valid provider and workspace ids are required" }, { status: 400 });
  }
  const auth = await capabilityAdmin(req, workspaceId);
  if (auth instanceof Response) return auth;
  const detail = await loadProviderDetail(getSupabaseAdmin(), workspaceId, params.data.id);
  return detail
    ? Response.json(detail)
    : Response.json({ error: "provider_not_found" }, { status: 404 });
});

export const PATCH = withRoute(async (
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) => {
  const params = ParamsSchema.safeParse(await ctx.params);
  if (!params.success) return Response.json({ error: "invalid_provider_id" }, { status: 400 });
  const input = await parseJson(req, UpdateCapabilityProviderInputSchema);
  if (input instanceof Response) return input;
  const auth = await capabilityAdmin(req, input.workspace_id);
  if (auth instanceof Response) return auth;

  const admin = getSupabaseAdmin();
  const { data: current } = await admin
    .from("capabilities")
    .select("id,type,deleted_at")
    .eq("workspace_id", input.workspace_id)
    .eq("id", params.data.id)
    .maybeSingle();
  if (!current || current.deleted_at) {
    return Response.json({ error: "provider_not_found" }, { status: 404 });
  }
  if (current.type !== input.type) {
    return Response.json({ error: "provider_type_immutable", message: "Provider type cannot be changed after creation" }, { status: 409 });
  }

  const endpoint = new URL(input.connection.endpointUrl);
  const contractDigest = await sha256Hex(stableJson(input.contract));
  const provenance = normalizedProvenance(input.provenance, endpoint);
  let secretRef: string | null = null;
  if (input.connection.secret) {
    try {
      secretRef = await storeConnectionSecret({ workspaceId: input.workspace_id, plaintext: input.connection.secret });
    } catch (error) {
      if (error instanceof ConnectionSecretError) {
        return Response.json({ error: error.code, message: error.message }, { status: 503 });
      }
      throw error;
    }
  }
  const { data, error } = await admin.rpc("update_capability_provider", {
    p_workspace_id: input.workspace_id,
    p_user_id: auth.userId,
    p_capability_id: params.data.id,
    p_expected_updated_at: input.expected_updated_at,
    p_provider: input.provider,
    p_title: input.title,
    p_description: input.description,
    p_provenance: provenance,
    p_environment: input.environment,
    p_contract: input.contract,
    p_contract_digest: contractDigest,
    p_endpoint_url: endpoint.toString(),
    p_auth_type: input.connection.authType,
    p_auth_header_name: input.connection.authHeaderName ?? null,
    p_secret_ref: secretRef,
    p_allowed_hosts: [endpoint.hostname],
    p_timeout_ms: input.connection.timeoutMs,
    p_preserve_credential: input.connection.credentialMode === "preserve",
    p_oauth_attempt_id: input.connection.oauthAttemptId ?? null,
  }).single();
  if (error || !data) {
    // The RPC refused (stale lock, bundle pin…): the row still points at the
    // old credential, so the one just stored has no owner.
    await discardConnectionSecret(secretRef);
    return providerMutationError(error);
  }

  const result = data as {
    capability_id: string;
    version_id: string;
    connection_id: string;
    grants_revoked: number;
    material_change: boolean;
  };
  void appendAudit({
    workspaceId: input.workspace_id,
    actorType: "user",
    actorId: auth.userId,
    action: "capability.update",
    targetType: "capability",
    targetId: params.data.id,
    input: {
      provider: input.provider,
      title: input.title,
      endpoint_host: endpoint.hostname,
      auth_type: input.connection.authType,
      credential_mode: input.connection.credentialMode,
    },
    output: {
      version_id: result.version_id,
      material_change: result.material_change,
      grants_revoked: result.grants_revoked,
    },
  });

  const detail = await loadProviderDetail(admin, input.workspace_id, params.data.id);
  return Response.json({
    ...detail,
    grants_revoked: result.grants_revoked,
    material_change: result.material_change,
  });
});

export const DELETE = withRoute(async (
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) => {
  const params = ParamsSchema.safeParse(await ctx.params);
  const requestUrl = new URL(req.url);
  const workspaceId = requestUrl.searchParams.get("workspace_id");
  const expectedUpdatedAt = requestUrl.searchParams.get("expected_updated_at");
  if (
    !params.success
    || !workspaceId || !WorkspaceSchema.safeParse(workspaceId).success
    || (expectedUpdatedAt && !z.string().datetime({ offset: true }).safeParse(expectedUpdatedAt).success)
  ) {
    return Response.json({ error: "invalid_request", message: "valid provider and workspace ids are required" }, { status: 400 });
  }
  const auth = await capabilityAdmin(req, workspaceId);
  if (auth instanceof Response) return auth;
  const { data, error } = await getSupabaseAdmin().rpc("remove_capability_provider", {
    p_workspace_id: workspaceId,
    p_user_id: auth.userId,
    p_capability_id: params.data.id,
    p_expected_updated_at: expectedUpdatedAt ?? null,
  }).single();
  if (error || !data) return providerMutationError(error);
  const result = data as { capability_id: string; grants_revoked: number; already_removed: boolean };
  void appendAudit({
    workspaceId,
    actorType: "user",
    actorId: auth.userId,
    action: "capability.delete",
    targetType: "capability",
    targetId: params.data.id,
    output: {
      grants_revoked: result.grants_revoked,
      already_removed: result.already_removed,
      history_preserved: true,
    },
  });
  return Response.json({ ok: true, ...result, history_preserved: true });
});

async function loadProviderDetail(admin: AdminClient, workspaceId: string, capabilityId: string) {
  const { data: capability } = await admin
    .from("capabilities")
    .select("id,key,type,provider,title,description,provenance,status,current_version_id,disabled_at,deleted_at,created_at,updated_at")
    .eq("workspace_id", workspaceId)
    .eq("id", capabilityId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!capability?.current_version_id) return null;

  const [{ data: version }, { data: connection }] = await Promise.all([
    admin
      .from("capability_versions")
      .select("id,version,environment,contract,contract_digest,created_at")
      .eq("workspace_id", workspaceId)
      .eq("capability_id", capabilityId)
      .eq("id", capability.current_version_id)
      .maybeSingle(),
    admin
      .from("capability_connections")
      .select("id,environment,endpoint_url,auth_type,auth_header_name,secret_ref,allowed_hosts,timeout_ms,enabled,updated_at")
      .eq("workspace_id", workspaceId)
      .eq("capability_id", capabilityId)
      .eq("environment", "production")
      .maybeSingle(),
  ]);
  if (!version || !connection) return null;

  let credentialStatus: string | null = null;
  if (connection.auth_type === "oauth") {
    const { data: credential } = await admin
      .from("capability_oauth_credentials")
      .select("status")
      .eq("workspace_id", workspaceId)
      .eq("connection_id", connection.id)
      .maybeSingle();
    credentialStatus = credential?.status ?? null;
  }
  const credentialConfigured = connection.auth_type === "none"
    || (connection.auth_type === "oauth"
      ? credentialStatus === "active" || credentialStatus === "refreshing"
      : Boolean(connection.secret_ref));

  return {
    capability,
    version,
    connection: {
      id: connection.id,
      environment: connection.environment,
      endpoint_url: connection.endpoint_url,
      auth_type: connection.auth_type,
      auth_header_name: connection.auth_header_name,
      allowed_hosts: connection.allowed_hosts,
      timeout_ms: connection.timeout_ms,
      enabled: connection.enabled,
      updated_at: connection.updated_at,
      credential_configured: credentialConfigured,
      credential_status: credentialStatus,
    },
  };
}

function normalizedProvenance(value: Record<string, unknown>, endpoint: URL): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...value,
    configured_from: "connections",
    endpoint_origin: endpoint.origin,
    endpoint_host: endpoint.hostname,
    identity_anchor: "endpoint_host",
  };
  const rawLogo = next.logo_url;
  if (typeof rawLogo !== "string") return next;
  try {
    const logo = new URL(rawLogo);
    if (
      logo.protocol === "https:"
      && providerBrandHosts(endpoint).includes(logo.hostname.toLowerCase())
    ) return next;
  } catch {}
  const { logo_url: _logoUrl, logo_source: _logoSource, logo_identity_verified: _verified, ...withoutLogo } = next;
  return withoutLogo;
}

function providerMutationError(error: { message?: string; code?: string } | null) {
  const message = error?.message ?? "Provider mutation failed";
  if (message.includes("not_found")) {
    return Response.json({ error: "provider_not_found" }, { status: 404 });
  }
  if (message.includes("stale")) {
    return Response.json({ error: "provider_stale", message: "This provider changed in another session. Reload and try again." }, { status: 409 });
  }
  if (message.includes("used_by_bundle")) {
    return Response.json({ error: "provider_used_by_bundle", message: "This provider is pinned by a current bundle. Update that bundle before changing or deleting the provider." }, { status: 409 });
  }
  if (message.includes("credential_preserve_invalid")) {
    return Response.json({ error: "credential_replacement_required", message: "Reconnect or provide the credential again after changing this connection." }, { status: 409 });
  }
  if (message.includes("oauth_")) {
    return Response.json({ error: "oauth_update_failed", message: "OAuth authorization is no longer attachable. Reconnect the provider and try again." }, { status: 409 });
  }
  if (error?.code === "42501") {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  return Response.json({ error: "provider_mutation_failed", message: message.slice(0, 240) }, { status: 500 });
}
