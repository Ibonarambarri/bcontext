/**
 * The workspace taxonomy over REST — the REST twin of MCP `tags` /
 * `tags_write(op=create)`.
 *
 *   GET  /api/tags?workspace=…   tags with usage counts + the relation graph
 *   POST /api/tags               { workspace, name, description?, parent_ids?, related_ids? }
 *
 * Reading is the read verb; anyone who can read the workspace sees the whole
 * taxonomy, since tags never gate node access. Creating is `tags:create`,
 * which every writer holds (see `VERBS`): the tags come from whoever files
 * the work. `can_manage` on the GET says whether the caller may also merge
 * and delete (workspace admin), which is what the web's tag manager needs to
 * know before rendering those controls.
 */
import { z } from "zod";
import {
  actingUserId,
  requireWorkspaceAdmin,
} from "@/lib/auth/require";
import { openWorkspace } from "@/lib/auth/workspace";
import {
  TagConflictError,
  TagNotFoundError,
  TagRelationError,
} from "@/lib/storage";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { wsBroadcast } from "@/lib/collab/server-broadcast";

const CreateTagSchema = z.object({
  workspace: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).nullable().optional(),
  parent_ids: z.array(z.string().min(1)).max(50).optional(),
  related_ids: z.array(z.string().min(1)).max(50).optional(),
});

export const GET = withRoute(async (req: Request) => {
  const workspace = new URL(req.url).searchParams.get("workspace")?.trim();
  const ctx = await openWorkspace(req, workspace, "read");
  if (ctx instanceof Response) return ctx;
  const { storage, actor } = ctx;
  const [tags, counts, relations] = await Promise.all([
    storage.listTags(),
    storage.countTagUsage(),
    storage.listTagRelations(),
  ]);
  const adminDenied = await requireWorkspaceAdmin(actor, storage);
  return Response.json({
    tags: tags.map((tag) => ({ ...tag, usage_count: counts.get(tag.id) ?? 0 })),
    relations: relations.map((relation) => ({
      id: relation.id,
      from_tag_id: relation.from_tag_id,
      to_tag_id: relation.to_tag_id,
      relation: relation.relation,
    })),
    can_manage: adminDenied === null,
  });
});

export const POST = withRoute(async (req: Request) => {
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = CreateTagSchema.safeParse(body.data);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const ctx = await openWorkspace(req, parsed.data.workspace, "tags:create");
  if (ctx instanceof Response) return ctx;
  const { storage, actor } = ctx;
  try {
    const tag = await storage.createTag({
      name: parsed.data.name,
      description: parsed.data.description,
      created_by: actingUserId(actor),
    });
    let relations: Array<{ id: string; from_tag_id: string; to_tag_id: string; relation: string }> = [];
    if (parsed.data.parent_ids?.length || parsed.data.related_ids?.length) {
      try {
        const created = await storage.createTagRelations(tag.id, {
          parent_ids: parsed.data.parent_ids,
          related_ids: parsed.data.related_ids,
        });
        relations = created.map((relation) => ({
          id: relation.id,
          from_tag_id: relation.from_tag_id,
          to_tag_id: relation.to_tag_id,
          relation: relation.relation,
        }));
      } catch (relationError) {
        // The tag itself was already created — the two writes are not one
        // transaction. Surface the relation failure with the tag so the caller
        // can retry via POST /api/tags/:id/relations instead of silently
        // dropping it.
        if (relationError instanceof TagRelationError) {
          return Response.json(
            { tag, error: relationError.code, message: relationError.message },
            { status: 422 },
          );
        }
        if (relationError instanceof TagNotFoundError) {
          return Response.json(
            { tag, error: "unknown_or_inactive_tag", tag_id: relationError.tagId },
            { status: 400 },
          );
        }
        throw relationError;
      }
    }
    if (storage.backend === "supabase") void wsBroadcast.graphChanged(storage.workspace.id, "taxonomy", "created", tag.id);
    return Response.json({ tag, relations }, { status: 201 });
  } catch (error) {
    if (error instanceof TagConflictError) {
      return Response.json({ error: error.code, message: error.message }, { status: 409 });
    }
    throw error;
  }
});
