/**
 * GET   /api/admin/errors/[id] — one problem: the group, its twenty most
 *       recent occurrences (stacks, request ids, context and all) and the
 *       people it reached, addresses resolved where the auth server's paged
 *       list reaches them and the bare id where it does not.
 * PATCH /api/admin/errors/[id] — triage. `status` moves it along the ladder
 *       and `note` records what the operator learned; `note: null` or an
 *       empty string clears it. Resolving stamps `resolved_at` and the build
 *       it was called fixed on — and does not stop the collector reopening
 *       the group the next time it happens, which is the point.
 *
 * Platform admins only.
 */
import { z } from "zod";
import { gateAdmin } from "@/lib/admin/access";
import {
  AdminErrorError,
  getAdminErrorGroup,
  updateAdminErrorGroup,
} from "@/lib/admin/errors";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { ERROR_STATUSES } from "@bcontext-dev/contract/errors";

const PatchSchema = z
  .object({
    status: z.enum(ERROR_STATUSES),
    // Nullable, not optional-only: clearing a note and not touching one are
    // different acts, and `undefined` cannot say the first.
    note: z.string().max(4_000).nullable(),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to change.");

export const GET = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const admin = await gateAdmin(req);
  if (admin instanceof Response) return admin;
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return Response.json({ error: "invalid_id" }, { status: 400 });
  }
  const detail = await getAdminErrorGroup(id);
  if (!detail) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json(detail);
});

export const PATCH = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const admin = await gateAdmin(req);
  if (admin instanceof Response) return admin;
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return Response.json({ error: "invalid_id" }, { status: 400 });
  }
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = PatchSchema.safeParse(body.data);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_body", message: parsed.error.issues[0]?.message ?? "invalid body" },
      { status: 400 },
    );
  }
  try {
    return Response.json(await updateAdminErrorGroup(id, parsed.data));
  } catch (err) {
    if (err instanceof AdminErrorError) {
      return Response.json({ error: err.code, message: err.message }, { status: err.status });
    }
    throw err;
  }
});
