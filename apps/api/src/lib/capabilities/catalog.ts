/**
 * Resolves which external tools an MCP caller may see and call. Reads the
 * caller's `capability_principals` row, expands its direct and bundle grants
 * (`discover` and `invoke` both required), keeps only `approved`, enabled,
 * executable capabilities with an enabled production connection, and returns
 * one `AuthorizedCapabilityTool` per remote tool under the stable
 * `<provider>/<capability>/<tool>` ref.
 *
 * Called by the MCP server on every `capability_search`, every
 * `capability_call` and every `brief` — deliberately uncached, so a
 * revocation is immediate. `tools/list` never calls it: the list is the same
 * whatever the caller has been granted.
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  ExecutableContractSchema,
  type AuthorizedCapabilityTool,
  type CapabilityActor,
  type CapabilityConnection,
  type CapabilityType,
} from "./types";
import { supabaseConfigured } from "@/lib/env";

interface PrincipalRow {
  id: string;
}

interface GrantRow {
  capability_id: string | null;
  bundle_id: string | null;
  actions: string[];
  constraints: Record<string, unknown> | null;
  expires_at: string | null;
  revoked_at: string | null;
}

interface CapabilityRow {
  id: string;
  key: string;
  type: CapabilityType;
  provider: string;
  title: string;
  description: string;
  status: string;
  current_version_id: string | null;
  disabled_at: string | null;
}

interface VersionRow {
  id: string;
  capability_id: string;
  version: number;
  contract: unknown;
}

interface ConnectionRow {
  id: string;
  capability_id: string;
  endpoint_url: string;
  auth_type: "none" | "oauth" | "bearer" | "header";
  auth_header_name: string | null;
  secret_ref: string | null;
  allowed_hosts: string[] | null;
  timeout_ms: number;
}

interface GrantAccess {
  actions: Set<string>;
  constraints: Record<string, unknown>;
  versionIds: Set<string>;
}

/**
 * Resolve the principal bound to this MCP caller, expand direct + bundle
 * grants, and return only executable approved tools. Every call is a fresh DB
 * read: grant revocation and capability disablement take effect without the
 * client reconnecting.
 */
export async function listAuthorizedCapabilityTools(
  actor: CapabilityActor,
): Promise<AuthorizedCapabilityTool[]> {
  if (!supabaseConfigured()) {
    return [];
  }
  const sb = getSupabaseAdmin();
  const sourceType = actor.agentId
    ? "agent"
    : actor.tokenScope === "user" ? "user" : "agent_token";
  const sourceId = actor.agentId ?? (actor.tokenScope === "user" ? actor.userId : actor.tokenId);
  if (!sourceId) return [];

  const { data: principal, error: principalError } = await sb
    .from("capability_principals")
    .select("id")
    .eq("workspace_id", actor.workspaceId)
    .eq("source_type", sourceType)
    .eq("source_id", sourceId)
    .is("disabled_at", null)
    .maybeSingle();
  if (principalError) throw new Error(`capability principal lookup failed: ${principalError.message}`);
  if (!principal) return [];

  const principalId = (principal as PrincipalRow).id;
  const { data: grantData, error: grantError } = await sb
    .from("capability_grants")
    .select("capability_id,bundle_id,actions,constraints,expires_at,revoked_at")
    .eq("workspace_id", actor.workspaceId)
    .eq("principal_id", principalId)
    .is("revoked_at", null);
  if (grantError) throw new Error(`capability grants lookup failed: ${grantError.message}`);

  const now = Date.now();
  const grants = ((grantData ?? []) as GrantRow[]).filter(
    (grant) => !grant.expires_at || Date.parse(grant.expires_at) > now,
  );
  const directIds = unique(grants.flatMap((grant) => grant.capability_id ? [grant.capability_id] : []));
  const bundleIds = unique(grants.flatMap((grant) => grant.bundle_id ? [grant.bundle_id] : []));

  const bundleVersionByBundle = new Map<string, string>();
  if (bundleIds.length > 0) {
    const { data, error } = await sb
      .from("capability_bundles")
      .select("id,current_version_id,status")
      .eq("workspace_id", actor.workspaceId)
      .in("id", bundleIds)
      .eq("status", "approved");
    if (error) throw new Error(`capability bundles lookup failed: ${error.message}`);
    for (const row of (data ?? []) as Array<{ id: string; current_version_id: string | null }>) {
      if (row.current_version_id) bundleVersionByBundle.set(row.id, row.current_version_id);
    }
  }

  const itemVersionByBundleVersion = new Map<string, string[]>();
  const bundleVersionIds = unique([...bundleVersionByBundle.values()]);
  if (bundleVersionIds.length > 0) {
    const { data, error } = await sb
      .from("capability_bundle_items")
      .select("bundle_version_id,capability_version_id")
      .in("bundle_version_id", bundleVersionIds);
    if (error) throw new Error(`capability bundle items lookup failed: ${error.message}`);
    for (const row of (data ?? []) as Array<{ bundle_version_id: string; capability_version_id: string }>) {
      const items = itemVersionByBundleVersion.get(row.bundle_version_id) ?? [];
      items.push(row.capability_version_id);
      itemVersionByBundleVersion.set(row.bundle_version_id, items);
    }
  }

  const accessByCapability = new Map<string, GrantAccess>();
  const bundleVersionIdsToLoad = new Set<string>();
  for (const grant of grants) {
    if (!grant.actions.includes("discover") || !grant.actions.includes("invoke")) continue;
    if (grant.capability_id) {
      mergeAccess(accessByCapability, grant.capability_id, grant, []);
    }
    if (grant.bundle_id) {
      const bundleVersionId = bundleVersionByBundle.get(grant.bundle_id);
      if (!bundleVersionId) continue;
      for (const versionId of itemVersionByBundleVersion.get(bundleVersionId) ?? []) {
        bundleVersionIdsToLoad.add(versionId);
      }
    }
  }

  const bundleVersionRows = await loadVersions(sb, actor.workspaceId, [...bundleVersionIdsToLoad]);
  for (const grant of grants) {
    if (!grant.bundle_id || !grant.actions.includes("discover") || !grant.actions.includes("invoke")) continue;
    const bundleVersionId = bundleVersionByBundle.get(grant.bundle_id);
    if (!bundleVersionId) continue;
    for (const versionId of itemVersionByBundleVersion.get(bundleVersionId) ?? []) {
      const version = bundleVersionRows.get(versionId);
      if (version) mergeAccess(accessByCapability, version.capability_id, grant, [versionId]);
    }
  }

  const capabilityIds = unique([...accessByCapability.keys(), ...directIds]);
  if (capabilityIds.length === 0) return [];
  const { data: capabilityData, error: capabilityError } = await sb
    .from("capabilities")
    .select("id,key,type,provider,title,description,status,current_version_id,disabled_at")
    .eq("workspace_id", actor.workspaceId)
    .in("id", capabilityIds)
    .eq("status", "approved")
    .is("deleted_at", null)
    .is("disabled_at", null);
  if (capabilityError) throw new Error(`capabilities lookup failed: ${capabilityError.message}`);
  const capabilities = (capabilityData ?? []) as CapabilityRow[];

  const requestedVersionIds = new Set<string>(bundleVersionRows.keys());
  for (const cap of capabilities) {
    const access = accessByCapability.get(cap.id);
    if (access && access.versionIds.size === 0 && cap.current_version_id) {
      access.versionIds.add(cap.current_version_id);
      requestedVersionIds.add(cap.current_version_id);
    }
  }
  const versions = new Map(bundleVersionRows);
  const missingVersionIds = [...requestedVersionIds].filter((id) => !versions.has(id));
  for (const [id, row] of await loadVersions(sb, actor.workspaceId, missingVersionIds)) versions.set(id, row);

  const { data: connectionData, error: connectionError } = await sb
    .from("capability_connections")
    .select("id,capability_id,endpoint_url,auth_type,auth_header_name,secret_ref,allowed_hosts,timeout_ms")
    .eq("workspace_id", actor.workspaceId)
    .in("capability_id", capabilities.map((cap) => cap.id))
    .eq("environment", "production")
    .eq("enabled", true);
  if (connectionError) throw new Error(`capability connections lookup failed: ${connectionError.message}`);
  const connections = new Map(
    ((connectionData ?? []) as ConnectionRow[]).map((row) => [row.capability_id, mapConnection(row)]),
  );

  const tools: AuthorizedCapabilityTool[] = [];
  for (const capability of capabilities) {
    const access = accessByCapability.get(capability.id);
    const connection = connections.get(capability.id);
    if (!access || !connection) continue;
    const selectedVersions = [...access.versionIds]
      .map((id) => versions.get(id))
      .filter((version): version is VersionRow => Boolean(version))
      .sort((a, b) => b.version - a.version)
      .slice(0, 1);
    for (const version of selectedVersions) {
      if (!version || version.capability_id !== capability.id) continue;
      const parsed = ExecutableContractSchema.safeParse(version.contract);
      if (!parsed.success) continue; // Catalog may hold non-executable types.
      const contract = parsed.data;
      const remoteTools = contract.protocol === "mcp_streamable_http" ? contract.tools : [contract.tool];
      for (const remote of remoteTools) {
        if (!toolAllowed(remote.name, access.constraints)) continue;
        tools.push({
          workspaceId: actor.workspaceId,
          ref: capabilityRef(capability.provider, capability.key, remote.name),
          remoteName: remote.name,
          description: remote.description || capability.description || capability.title,
          capabilityTitle: capability.title,
          inputSchema: remote.inputSchema,
          ...(remote.outputSchema ? { outputSchema: remote.outputSchema } : {}),
          capabilityId: capability.id,
          capabilityVersionId: version.id,
          capabilityKey: capability.key,
          capabilityType: capability.type,
          provider: capability.provider,
          principalId,
          contract,
          connection,
          constraints: access.constraints,
        });
      }
    }
  }
  return tools.sort((a, b) => a.ref.localeCompare(b.ref));
}

/**
 * The handle an agent holds for a remote tool: `<provider>/<capability>/<tool>`.
 * It is only ever compared for equality against the refs the catalog produced
 * for the same caller, never parsed, so it needs no length cap and no hash —
 * it just has to be stable across sessions and readable in a transcript. The
 * provider is a free-text display name (`GitHub Cloud`) and is normalised;
 * the capability key is already constrained by the schema and the tool name
 * is the provider's own.
 */
export function capabilityRef(provider: string, capabilityKey: string, remoteName: string): string {
  return `${refPart(provider)}/${capabilityKey}/${remoteName}`;
}

/** Lower-case, `[a-z0-9_-]` only, so a ref never carries spaces or a second slash. */
export function refPart(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "external";
}

function toolAllowed(name: string, constraints: Record<string, unknown>): boolean {
  const allowed = constraints.allowed_tools;
  return !Array.isArray(allowed) || allowed.some((item) => item === name);
}

function mergeAccess(
  target: Map<string, GrantAccess>,
  capabilityId: string,
  grant: GrantRow,
  versionIds: string[],
): void {
  const current = target.get(capabilityId) ?? {
    actions: new Set<string>(),
    constraints: {},
    versionIds: new Set<string>(),
  };
  grant.actions.forEach((action) => current.actions.add(action));
  current.constraints = mergeConstraints(current.constraints, grant.constraints ?? {});
  versionIds.forEach((id) => current.versionIds.add(id));
  target.set(capabilityId, current);
}

function mergeConstraints(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const aTools = Array.isArray(a.allowed_tools) ? a.allowed_tools : null;
  const bTools = Array.isArray(b.allowed_tools) ? b.allowed_tools : null;
  if (!aTools) return { ...a, ...b };
  if (!bTools) return { ...b, ...a };
  return { ...a, ...b, allowed_tools: unique([...aTools, ...bTools].filter((v): v is string => typeof v === "string")) };
}

async function loadVersions(
  sb: ReturnType<typeof getSupabaseAdmin>,
  workspaceId: string,
  ids: string[],
): Promise<Map<string, VersionRow>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await sb
    .from("capability_versions")
    .select("id,capability_id,version,contract")
    .eq("workspace_id", workspaceId)
    .in("id", unique(ids));
  if (error) throw new Error(`capability versions lookup failed: ${error.message}`);
  return new Map(((data ?? []) as VersionRow[]).map((row) => [row.id, row]));
}

function mapConnection(row: ConnectionRow): CapabilityConnection {
  return {
    id: row.id,
    endpointUrl: row.endpoint_url,
    authType: row.auth_type,
    authHeaderName: row.auth_header_name,
    secretRef: row.secret_ref,
    allowedHosts: row.allowed_hosts ?? [],
    timeoutMs: row.timeout_ms,
  };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
