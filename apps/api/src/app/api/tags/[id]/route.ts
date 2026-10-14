/**
 * One tag — edit or delete. REST twin of MCP `tags_write(op=update|delete)`.
 *
 *   PATCH  /api/tags/:id                { workspace, name?, description? }
 *   DELETE /api/tags/:id?workspace=…
 *
 * Editing needs `tags:update`, which every writer holds; deleting needs
 * `tags:delete` AND workspace admin (see `adminStorage` for why the two
 * checks stack there). Every change broadcasts a taxonomy event so open
 * graphs redraw.
 */
import { z } from "zod";
import { requireWorkspaceAdmin } from "@/lib/auth/require";
import { openWorkspace } from "@/lib/auth/workspace";
import type { Verb } from "@/lib/auth/grants";
import {
  type Storage,
  TagConflictError,
  TagNotFoundError,
} from "@/lib/storage";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { wsBroadcast } from "@/lib/collab/server-broadcast";

// A partial edit: omitted keeps, `description: null` clears.
const UpdateTagSchema = z.object({
  workspace: z.string().min(1),
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).nullable().optional(),
}).refine((input) => input.name !== undefined || input.description !== undefined, {
  message: "give a new name and/or description",
});

/**
 * Deleting a tag drops it from every node it classifies, so on top of the
 * verb it keeps the org-role bar this route always had: the grant model is
 * not allowed to lower it.
 */
async function adminStorage(
  req: Request,
  workspace: string,
  verb: Verb,
): Promise<
  | { storage: Storage; response?: never }
  | { response: Response; storage?: never }
> {
  const ctx = await openWorkspace(req, workspace, verb);
  if (ctx instanceof Response) return { response: ctx };
  const adminDenied = await requireWorkspaceAdmin(ctx.actor, ctx.storage);
  if (adminDenied) return { response: adminDenied };
  return { storage: ctx.storage };
}

export const PATCH = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = UpdateTagSchema.safeParse(body.data);
  if (!parsed.success) return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  const ctx = await openWorkspace(req, parsed.data.workspace, "tags:update");
  if (ctx instanceof Response) return ctx;
  const { storage } = ctx;
  const { id } = await params;
  const { workspace: _workspace, ...patch } = parsed.data;
  try {
    const tag = await storage.updateTag(id, patch);
    if (storage.backend === "supabase") void wsBroadcast.graphChanged(storage.workspace.id, "taxonomy", "updated", tag.id);
    return Response.json({ tag });
  } catch (error) {
    if (error instanceof TagNotFoundError) return Response.json({ error: "not_found" }, { status: 404 });
    if (error instanceof TagConflictError) {
      return Response.json({ error: error.code, message: error.message }, { status: 409 });
    }
    throw error;
  }
});

export const DELETE = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const workspace = new URL(req.url).searchParams.get("workspace")?.trim();
  if (!workspace) return Response.json({ error: "?workspace=<slug> required" }, { status: 400 });
  const resolved = await adminStorage(req, workspace, "tags:delete");
  if (resolved.response) return resolved.response;
  if (!resolved.storage) throw new Error("tag storage resolution failed");
  const { id } = await params;
  const deleted = await resolved.storage.deleteTag(id);
  if (deleted && resolved.storage.backend === "supabase") void wsBroadcast.graphChanged(resolved.storage.workspace.id, "taxonomy", "deleted", id);
  return deleted
    ? Response.json({ ok: true })
    : Response.json({ error: "not_found" }, { status: 404 });
});
