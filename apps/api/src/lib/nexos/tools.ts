/**
 * The external capabilities granted to a Nexo: rows in `capability_grants`
 * for the Nexo's `capability_principals` row (source_type `agent`, source_id
 * the Nexo's agent id) — the same rows the MCP gateway resolves, so whatever
 * is granted here is exactly what `listAuthorizedCapabilityTools` returns for
 * the Nexo's actor.
 *
 * Callers: `GET/PUT /api/nexos/:id/tools` and the Nexo detail route. The demo
 * backend has no capability gateway: reads answer an empty set and writes are
 * refused by the route.
 *
 * Must not break: PUT is the full desired set. Grants not in it are revoked
 * (soft, `revoked_at`, kept for the audit trail); only `approved`
 * capabilities and bundles of this workspace can be granted.
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { Nexo, NexoToolGrant, NexoTools } from "@bcontext-dev/contract/nexos";
import type { NexoTarget } from "./types";

/** Thrown when a requested capability or bundle is not an approved one of this workspace. */
export class InvalidToolGrantError extends Error {
  constructor() {
    super("invalid_capability_grant");
    this.name = "InvalidToolGrantError";
  }
}

async function principalId(workspaceId: string, agentId: string): Promise<string | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("capability_principals")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("source_type", "agent")
    .eq("source_id", agentId)
    .is("disabled_at", null)
    .maybeSingle();
  if (error) throw new Error(`nexos.tools.principal: ${error.message}`);
  return data?.id ? String(data.id) : null;
}

/** The Nexo's brain tools plus its live capability grants, with titles. */
export async function getNexoTools(t: NexoTarget, nexo: Nexo): Promise<NexoTools> {
  if (t.backend !== "supabase") return { brain_tools: nexo.brain_tools, principal_id: null, grants: [] };
  const principal = await principalId(t.workspaceId, nexo.agent_id);
  if (!principal) return { brain_tools: nexo.brain_tools, principal_id: null, grants: [] };

  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("capability_grants")
    .select("id,capability_id,bundle_id,actions,expires_at,created_at")
    .eq("workspace_id", t.workspaceId)
    .eq("principal_id", principal)
    .is("revoked_at", null)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`nexos.tools.grants: ${error.message}`);
  const rows = (data ?? []) as Array<Record<string, unknown>>;

  const capIds = rows.map((r) => r.capability_id).filter((v): v is string => typeof v === "string");
  const bundleIds = rows.map((r) => r.bundle_id).filter((v): v is string => typeof v === "string");
  const [caps, bundles] = await Promise.all([
    capIds.length
      ? admin.from("capabilities").select("id,title").eq("workspace_id", t.workspaceId).in("id", capIds)
      : Promise.resolve({ data: [] as Array<{ id: string; title: string }> }),
    bundleIds.length
      ? admin.from("capability_bundles").select("id,title").eq("workspace_id", t.workspaceId).in("id", bundleIds)
      : Promise.resolve({ data: [] as Array<{ id: string; title: string }> }),
  ]);
  const titles = new Map<string, string>();
  for (const r of [...((caps.data ?? []) as Array<{ id: string; title: string }>), ...((bundles.data ?? []) as Array<{ id: string; title: string }>)]) {
    titles.set(r.id, r.title);
  }

  const now = Date.now();
  const grants: NexoToolGrant[] = rows
    .filter((r) => !r.expires_at || Date.parse(String(r.expires_at)) > now)
    .map((r) => {
      const capabilityId = typeof r.capability_id === "string" ? r.capability_id : null;
      const bundleId = typeof r.bundle_id === "string" ? r.bundle_id : null;
      return {
        id: String(r.id),
        capability_id: capabilityId,
        bundle_id: bundleId,
        title: titles.get(capabilityId ?? bundleId ?? "") ?? null,
        actions: Array.isArray(r.actions) ? (r.actions as string[]) : [],
        expires_at: typeof r.expires_at === "string" ? r.expires_at : null,
        created_at: String(r.created_at ?? ""),
      };
    });
  return { brain_tools: nexo.brain_tools, principal_id: principal, grants };
}

/**
 * Make the Nexo's grants exactly `capabilityIds` + `bundleIds`. Re-enables
 * the principal if it had been disabled. Returns the resulting tool set.
 */
export async function setNexoCapabilityGrants(
  t: NexoTarget,
  nexo: Nexo,
  input: { capabilityIds: string[]; bundleIds: string[]; userId: string | null },
): Promise<NexoTools> {
  const admin = getSupabaseAdmin();
  const capabilityIds = [...new Set(input.capabilityIds)];
  const bundleIds = [...new Set(input.bundleIds)];

  const [validCaps, validBundles] = await Promise.all([
    capabilityIds.length
      ? admin.from("capabilities").select("id").eq("workspace_id", t.workspaceId).eq("status", "approved").is("deleted_at", null).in("id", capabilityIds)
      : Promise.resolve({ data: [] as Array<{ id: string }>, error: null }),
    bundleIds.length
      ? admin.from("capability_bundles").select("id").eq("workspace_id", t.workspaceId).eq("status", "approved").in("id", bundleIds)
      : Promise.resolve({ data: [] as Array<{ id: string }>, error: null }),
  ]);
  if (validCaps.error || validBundles.error) {
    throw new Error(`nexos.tools.validate: ${(validCaps.error ?? validBundles.error)!.message}`);
  }
  if ((validCaps.data ?? []).length !== capabilityIds.length || (validBundles.data ?? []).length !== bundleIds.length) {
    throw new InvalidToolGrantError();
  }

  const { data: principal, error: principalError } = await admin
    .from("capability_principals")
    .upsert(
      {
        workspace_id: t.workspaceId,
        kind: "agent",
        source_type: "agent",
        source_id: nexo.agent_id,
        display_name: nexo.name,
        disabled_at: null,
      },
      { onConflict: "workspace_id,source_type,source_id" },
    )
    .select("id")
    .single();
  if (principalError || !principal) throw new Error(`nexos.tools.principal: ${principalError?.message ?? "no row"}`);
  const principalId = String(principal.id);

  const { data: live, error: liveError } = await admin
    .from("capability_grants")
    .select("id,capability_id,bundle_id")
    .eq("workspace_id", t.workspaceId)
    .eq("principal_id", principalId)
    .is("revoked_at", null);
  if (liveError) throw new Error(`nexos.tools.live: ${liveError.message}`);
  const liveRows = (live ?? []) as Array<{ id: string; capability_id: string | null; bundle_id: string | null }>;

  const wantCap = new Set(capabilityIds);
  const wantBundle = new Set(bundleIds);
  const revoke = liveRows.filter((g) =>
    g.capability_id ? !wantCap.has(g.capability_id) : g.bundle_id ? !wantBundle.has(g.bundle_id) : true,
  );
  const haveCap = new Set(liveRows.map((g) => g.capability_id).filter(Boolean));
  const haveBundle = new Set(liveRows.map((g) => g.bundle_id).filter(Boolean));
  const insert = [
    ...capabilityIds.filter((id) => !haveCap.has(id)).map((id) => ({ capability_id: id, bundle_id: null })),
    ...bundleIds.filter((id) => !haveBundle.has(id)).map((id) => ({ capability_id: null, bundle_id: id })),
  ];

  if (revoke.length > 0) {
    const { error } = await admin
      .from("capability_grants")
      .update({ revoked_at: new Date().toISOString() })
      .eq("workspace_id", t.workspaceId)
      .in("id", revoke.map((g) => g.id));
    if (error) throw new Error(`nexos.tools.revoke: ${error.message}`);
  }
  if (insert.length > 0) {
    const { error } = await admin.from("capability_grants").insert(
      insert.map((g) => ({
        workspace_id: t.workspaceId,
        principal_id: principalId,
        ...g,
        actions: ["discover", "invoke"],
        constraints: {},
        created_by: input.userId,
      })),
    );
    if (error) throw new Error(`nexos.tools.insert: ${error.message}`);
  }
  return getNexoTools(t, nexo);
}
