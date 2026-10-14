/**
 * PATCH /api/workspaces/:ws — name, slug, accent.
 *
 * The settings drawer's "General" tab. Admin verb on the workspace, and a
 * person: renaming a tenant is not something a token does on its own, the
 * same line the members roster draws.
 */
import { z } from "zod";
import { openWorkspace } from "@/lib/auth/workspace";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { slugify } from "@bcontext-dev/contract/utils";
import { GRADIENTS } from "@bcontext-dev/contract/workspace-gradients";
import { listWorkspacesForUser } from "@/lib/workspaces/registry";
import type { WorkspacePatch } from "@bcontext-dev/contract/workspaces";

const Patch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  slug: z.string().trim().min(1).max(64).optional(),
  accent_hue: z.number().int().min(0).max(360).nullable().optional(),
  accent_gradient: z
    .string()
    .refine((id) => GRADIENTS.some((g) => g.id === id), "unknown gradient")
    .optional(),
}) satisfies z.ZodType<WorkspacePatch>;

export const PATCH = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ ws: string }> },
) => {
  const { ws } = await params;
  const ctx = await openWorkspace(req, ws, "admin");
  if (ctx instanceof Response) return ctx;
  const { storage, actor } = ctx;
  if (actor.kind !== "user") {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (storage.backend !== "supabase") {
    return Response.json(
      { error: "unsupported", message: "Workspace settings need Supabase." },
      { status: 400 },
    );
  }

  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = Patch.safeParse(body.data);
  if (!parsed.success) {
    return Response.json({ error: "invalid_body", message: parsed.error.issues[0]?.message ?? "invalid body", issues: parsed.error.flatten() }, { status: 400 });
  }
  const { name, slug: rawSlug, accent_hue, accent_gradient } = parsed.data;
  const current = storage.workspace;

  const patch: Record<string, unknown> = {};
  if (name) patch.name = name;
  const slug = rawSlug ? slugify(rawSlug) : "";
  if (slug && slug !== current.slug) {
    // Slugs are unique per organisation, not globally, and every workspace is
    // its own organisation — so the database would happily let this one take
    // the slug of another workspace the same person belongs to, after which
    // `/w/<slug>` resolves to whichever comes first. Refused where the person
    // can see the clash.
    const reachable = await listWorkspacesForUser(actor.userId);
    if (reachable.some((w) => w.id !== current.id && w.slug === slug)) {
      return Response.json(
        { error: "slug_taken", message: "That slug is already in use." },
        { status: 409 },
      );
    }
    patch.slug = slug;
  }
  // Merged into the row's metadata so the accent does not clobber whatever
  // else lives in that jsonb. `null` hue means "leave the deterministic one".
  const meta: Record<string, unknown> = {};
  if (typeof accent_hue === "number") meta.accent_hue = accent_hue;
  if (accent_gradient) meta.accent_gradient = accent_gradient;
  if (Object.keys(meta).length > 0) {
    patch.metadata = { ...(current.metadata ?? {}), ...meta };
  }
  if (Object.keys(patch).length === 0) {
    return Response.json({ workspace: current });
  }

  const admin = getSupabaseAdmin();
  const { data: row, error } = await admin
    .from("workspaces")
    .update(patch)
    .eq("id", current.id)
    .select("id, organization_id, slug, name, description, github_repo, metadata, created_at")
    .single();
  if (error || !row) {
    // A taken slug is the only failure a person can do something about.
    const taken = error?.code === "23505";
    return Response.json(
      { error: taken ? "slug_taken" : "update_failed", message: taken ? "That slug is already in use." : error?.message ?? "update failed" },
      { status: taken ? 409 : 500 },
    );
  }
  // The hidden org carries the same name so audit logs read sensibly.
  if (name) {
    await admin.from("organizations").update({ name }).eq("id", current.organization_id);
  }
  return Response.json({ workspace: row });
});
