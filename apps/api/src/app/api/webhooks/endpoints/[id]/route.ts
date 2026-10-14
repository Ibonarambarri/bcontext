/**
 * Webhook endpoint detail — delete + pause/unpause + test fire.
 *
 *   DELETE /api/webhooks/endpoints/[id]
 *   PATCH  /api/webhooks/endpoints/[id]  { paused?: boolean }
 *   POST   /api/webhooks/endpoints/[id]/test  -> sends a test ping
 */
import { z } from "zod";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getSupabaseForRequest } from "@/lib/supabase/request";
import { withRoute } from "@/lib/route";
import { emitEvent } from "@/lib/webhooks/dispatch";

const ParamsSchema = z.object({ id: z.string().uuid() });
const PatchSchema = z.object({ paused: z.boolean() });

export const DELETE = withRoute(async (
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) => {
  const raw = await ctx.params;
  const parsed = ParamsSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_request", message: "id must be a uuid" },
      { status: 400 },
    );
  }

  const supabase = getSupabaseForRequest(req);
  const { data: session } = await supabase.auth.getUser();
  if (!session.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { error } = await supabase
    .from("webhook_endpoints")
    .delete()
    .eq("id", parsed.data.id);
  if (error) {
    if (/row-level security|permission denied/i.test(error.message)) {
      return Response.json(
        { error: "forbidden", message: "owner or admin role required" },
        { status: 403 },
      );
    }
    return Response.json(
      { error: "internal", message: error.message },
      { status: 500 },
    );
  }
  return Response.json({ ok: true });
});

export const PATCH = withRoute(async (
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) => {
  const raw = await ctx.params;
  const params = ParamsSchema.safeParse(raw);
  if (!params.success) {
    return Response.json(
      { error: "invalid_request", message: "id must be a uuid" },
      { status: 400 },
    );
  }
  let body: z.infer<typeof PatchSchema>;
  try {
    const json = await req.json();
    const result = PatchSchema.safeParse(json);
    if (!result.success) {
      return Response.json(
        { error: "invalid_request", issues: result.error.flatten() },
        { status: 400 },
      );
    }
    body = result.data;
  } catch {
    return Response.json(
      { error: "invalid_request", message: "body must be JSON" },
      { status: 400 },
    );
  }

  const supabase = getSupabaseForRequest(req);
  const { data: session } = await supabase.auth.getUser();
  if (!session.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { error } = await supabase
    .from("webhook_endpoints")
    .update({ paused: body.paused })
    .eq("id", params.data.id);
  if (error) {
    if (/row-level security|permission denied/i.test(error.message)) {
      return Response.json(
        { error: "forbidden", message: "owner or admin role required" },
        { status: 403 },
      );
    }
    return Response.json(
      { error: "internal", message: error.message },
      { status: 500 },
    );
  }
  return Response.json({ ok: true });
});

/**
 * Fire a synthetic `job.completed` event at the endpoint. Useful for
 * verifying that the receiver can validate the signature without waiting
 * for a real node write.
 */
export const POST = withRoute(async (
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) => {
  const raw = await ctx.params;
  const params = ParamsSchema.safeParse(raw);
  if (!params.success) {
    return Response.json(
      { error: "invalid_request", message: "id must be a uuid" },
      { status: 400 },
    );
  }

  const supabase = getSupabaseForRequest(req);
  const { data: session } = await supabase.auth.getUser();
  if (!session.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // Verify ownership via RLS, and grab workspace_id + slug.
  const { data: ep, error } = await supabase
    .from("webhook_endpoints")
    .select("id, workspace_id")
    .eq("id", params.data.id)
    .maybeSingle();
  if (error) {
    return Response.json(
      { error: "internal", message: error.message },
      { status: 500 },
    );
  }
  if (!ep) {
    return Response.json(
      { error: "not_found", message: "endpoint not found" },
      { status: 404 },
    );
  }

  const admin = getSupabaseAdmin();
  const { data: ws } = await admin
    .from("workspaces")
    .select("slug")
    .eq("id", ep.workspace_id)
    .single();
  const slug = (ws?.slug as string | undefined) ?? "unknown";

  await emitEvent(admin, {
    workspaceId: ep.workspace_id,
    workspaceSlug: slug,
    type: "job.completed",
    data: { test: true, message: "bcontext webhook test ping" },
  });
  return Response.json({ ok: true });
});
