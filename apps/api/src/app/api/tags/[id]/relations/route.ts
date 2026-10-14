/**
 * Edges of the taxonomy graph — `parent` (hierarchy) and `related` (loose
 * association) between two tags.
 *
 *   POST   /api/tags/:id/relations   { workspace, to_tag_id, relation }
 *   DELETE /api/tags/:id/relations?workspace=…&to=…&relation=parent|related
 *
 * Verb `tags:update`, which every writer holds. A cycle or a duplicate is
 * 422 (`TagRelationError`); an unknown or inactive tag is 400.
 */
import { z } from "zod";
import { openWorkspace } from "@/lib/auth/workspace";
import {
  TagNotFoundError,
  TagRelationError,
} from "@/lib/storage";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { wsBroadcast } from "@/lib/collab/server-broadcast";

const CreateRelationSchema = z.object({
  workspace: z.string().min(1),
  to_tag_id: z.string().min(1),
  relation: z.enum(["parent", "related"]),
});

export const POST = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = CreateRelationSchema.safeParse(body.data);
  if (!parsed.success) return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  const ctx = await openWorkspace(req, parsed.data.workspace, "tags:update");
  if (ctx instanceof Response) return ctx;
  const { storage } = ctx;
  const { id } = await params;
  const { to_tag_id, relation } = parsed.data;
  try {
    const created = await storage.createTagRelations(id, {
      parent_ids: relation === "parent" ? [to_tag_id] : undefined,
      related_ids: relation === "related" ? [to_tag_id] : undefined,
    });
    if (storage.backend === "supabase") {
      void wsBroadcast.graphChanged(storage.workspace.id, "taxonomy", "updated", id);
    }
    return Response.json(
      {
        relations: created.map((r) => ({
          id: r.id,
          from_tag_id: r.from_tag_id,
          to_tag_id: r.to_tag_id,
          relation: r.relation,
        })),
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof TagRelationError) {
      return Response.json({ error: error.code, message: error.message }, { status: 422 });
    }
    if (error instanceof TagNotFoundError) {
      return Response.json({ error: "unknown_or_inactive_tag", tag_id: error.tagId }, { status: 400 });
    }
    throw error;
  }
});

export const DELETE = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const workspace = new URL(req.url).searchParams.get("workspace")?.trim();
  const to = new URL(req.url).searchParams.get("to")?.trim();
  const relation = new URL(req.url).searchParams.get("relation")?.trim();
  if (!workspace) {
    return Response.json({ error: "?workspace=<slug> required" }, { status: 400 });
  }
  if (!to || (relation !== "parent" && relation !== "related")) {
    return Response.json(
      { error: "?to=<tag_id>&relation=parent|related required" },
      { status: 400 },
    );
  }
  const ctx = await openWorkspace(req, workspace, "tags:update");
  if (ctx instanceof Response) return ctx;
  const { storage } = ctx;
  const { id } = await params;
  const deleted = await storage.deleteTagRelation({ fromTagId: id, toTagId: to, relation });
  if (deleted && storage.backend === "supabase") {
    void wsBroadcast.graphChanged(storage.workspace.id, "taxonomy", "updated", id);
  }
  return deleted
    ? Response.json({ ok: true })
    : Response.json({ error: "not_found" }, { status: 404 });
});
