/**
 * POST /api/capability-bundles — a named set of capability versions that can
 * be granted as one unit. Session-cookie owner|admin (`capabilityAdmin`).
 *
 * Bundle, version 1 and its items are three inserts rather than one RPC; the
 * partial-failure answers carry `bundle_id` so the admin can find and delete
 * the half-made row instead of hitting the unique key on retry.
 */
import { withRoute } from "@/lib/route";
import { capabilityAdmin, parseJson } from "@/lib/capabilities/admin";
import { CreateBundleInputSchema } from "@/lib/capabilities/admin-schemas";
import { appendAudit } from "@/lib/audit";

export const POST = withRoute(async (req: Request) => {
  const input = await parseJson(req, CreateBundleInputSchema);
  if (input instanceof Response) return input;
  const auth = await capabilityAdmin(req, input.workspace_id);
  if (auth instanceof Response) return auth;
  const sb = auth.supabase;
  const versionIds = [...new Set(input.capability_version_ids)];
  const { data: capabilities, error: lookupError } = await sb
    .from("capability_versions")
    .select("id")
    .eq("workspace_id", input.workspace_id)
    .in("id", versionIds);
  if (lookupError || (capabilities ?? []).length !== versionIds.length) {
    return Response.json({ error: "invalid_capability_versions" }, { status: 400 });
  }
  const { data: bundle, error: bundleError } = await sb
    .from("capability_bundles")
    .insert({
      workspace_id: input.workspace_id,
      key: input.key,
      title: input.title,
      description: input.description,
      status: "draft",
    })
    .select("id")
    .single();
  if (bundleError || !bundle) return Response.json({ error: "bundle_write_failed", message: bundleError?.message }, { status: 409 });
  const { data: version, error: versionError } = await sb
    .from("capability_bundle_versions")
    .insert({ workspace_id: input.workspace_id, bundle_id: bundle.id, version: 1, created_by: auth.userId })
    .select("id")
    .single();
  if (versionError || !version) return Response.json({ error: "bundle_version_write_failed", bundle_id: bundle.id }, { status: 500 });
  const { error: itemsError } = await sb.from("capability_bundle_items").insert(
    versionIds.map((capabilityVersionId) => ({
      workspace_id: input.workspace_id,
      bundle_version_id: version.id,
      capability_version_id: capabilityVersionId,
    })),
  );
  if (itemsError) return Response.json({ error: "bundle_items_write_failed", message: itemsError.message, bundle_id: bundle.id }, { status: 500 });
  const { data: updated, error: updateError } = await sb
    .from("capability_bundles")
    .update({ current_version_id: version.id, status: input.status })
    .eq("workspace_id", input.workspace_id)
    .eq("id", bundle.id)
    .select("*")
    .single();
  if (updateError || !updated) return Response.json({ error: "bundle_finalize_failed", bundle_id: bundle.id }, { status: 500 });
  void appendAudit({
    workspaceId: input.workspace_id,
    actorType: "user",
    actorId: auth.userId,
    action: "capability.bundle.create",
    targetType: "capability_bundle",
    targetId: bundle.id,
    input: { key: input.key, status: input.status, capability_version_ids: versionIds },
  });
  return Response.json({ bundle: updated, version_id: version.id }, { status: 201 });
});
