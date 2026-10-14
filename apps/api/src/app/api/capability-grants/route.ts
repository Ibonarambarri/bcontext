/**
 * POST /api/capability-grants — let a principal (an agent, a person, a
 * token) call one capability or one bundle. Session-cookie owner|admin
 * (`capabilityAdmin`).
 *
 * The principal row is upserted on `(workspace, source_type, source_id)` and
 * re-enabled if it had been disabled, so granting to a disconnected agent
 * quietly brings it back — the Agents page PATCH is the usual way in, this
 * route is the primitive underneath it.
 */
import { withRoute } from "@/lib/route";
import { capabilityAdmin, parseJson } from "@/lib/capabilities/admin";
import { CreateGrantInputSchema } from "@/lib/capabilities/admin-schemas";
import { appendAudit } from "@/lib/audit";

export const POST = withRoute(async (req: Request) => {
  const input = await parseJson(req, CreateGrantInputSchema);
  if (input instanceof Response) return input;
  const auth = await capabilityAdmin(req, input.workspace_id);
  if (auth instanceof Response) return auth;
  const sb = auth.supabase;
  const sourceId = input.principal.source_type === "user"
    ? input.principal.source_id ?? auth.userId
    : input.principal.source_id;
  if (!sourceId) return Response.json({ error: "invalid_request", message: "principal source_id is required" }, { status: 400 });
  const targetTable = input.capability_id ? "capabilities" : "capability_bundles";
  const targetId = input.capability_id ?? input.bundle_id!;
  const { data: target } = await sb
    .from(targetTable)
    .select("id")
    .eq("workspace_id", input.workspace_id)
    .eq("id", targetId)
    .maybeSingle();
  if (!target) return Response.json({ error: "target_not_found" }, { status: 404 });
  const { data: principal, error: principalError } = await sb
    .from("capability_principals")
    .upsert({
      workspace_id: input.workspace_id,
      kind: input.principal.kind,
      source_type: input.principal.source_type,
      source_id: sourceId,
      display_name: input.principal.display_name,
      disabled_at: null,
    }, { onConflict: "workspace_id,source_type,source_id" })
    .select("id")
    .single();
  if (principalError || !principal) return Response.json({ error: "principal_write_failed", message: principalError?.message }, { status: 500 });
  const { data: grant, error: grantError } = await sb
    .from("capability_grants")
    .insert({
      workspace_id: input.workspace_id,
      principal_id: principal.id,
      capability_id: input.capability_id ?? null,
      bundle_id: input.bundle_id ?? null,
      actions: input.actions,
      constraints: input.constraints,
      expires_at: input.expires_at ?? null,
      created_by: auth.userId,
    })
    .select("*")
    .single();
  if (grantError || !grant) return Response.json({ error: "grant_write_failed", message: grantError?.message }, { status: 500 });
  void appendAudit({
    workspaceId: input.workspace_id,
    actorType: "user",
    actorId: auth.userId,
    action: "capability.grant.create",
    targetType: "capability_grant",
    targetId: grant.id as string,
    input: {
      principal_id: principal.id,
      capability_id: input.capability_id ?? null,
      bundle_id: input.bundle_id ?? null,
      actions: input.actions,
      expires_at: input.expires_at ?? null,
    },
  });
  return Response.json({ principal_id: principal.id, grant }, { status: 201 });
});
