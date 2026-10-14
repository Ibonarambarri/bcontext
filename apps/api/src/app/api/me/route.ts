/**
 * GET /api/me — who the session belongs to, what they are called, whether
 * they are a platform admin and whether they may create an organization.
 * PATCH /api/me — the person edits their own name.
 *
 * The web lives in another repo and cannot import the admin allowlist, so
 * "is this person a platform admin" is answered here, over HTTP.
 * Session-cookie callers only: a bearer token is an agent, and an agent is
 * never a platform admin and has no name to edit.
 */
import { z } from "zod";
import { gate } from "@/lib/auth/require";
import { getSupabaseForRequest } from "@/lib/supabase/request";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { isAdminEmail } from "@/lib/admin/access";
import { mayCreateOrganization } from "@/lib/organizations/create";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { hasPasswordIdentity, meUserFrom, nameMetadata } from "@/lib/auth/profile";
import type { Me } from "@bcontext-dev/contract/me";
import { MAX_NAME_LENGTH } from "@bcontext-dev/contract/me";

export const GET = withRoute(async (req: Request) => {
  const gated = await gate(req);
  if (gated instanceof Response) return gated;
  if (gated.kind !== "user") {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const { data } = await getSupabaseForRequest(req).auth.getUser();
  const user = data.user ?? null;
  const me: Me = {
    user: meUserFrom(gated.userId, user),
    is_admin: isAdminEmail(user?.email ?? null),
    has_password: hasPasswordIdentity(user),
    can_create_organization: mayCreateOrganization(user?.email ?? null),
  };
  return Response.json(me);
});

/**
 * Both halves are optional and either may be cleared with an empty string —
 * a person who gave a surname once is allowed to take it back, and a form
 * that can only ever add would make the field a one-way door.
 */
const Patch = z.object({
  first_name: z.string().max(MAX_NAME_LENGTH).optional(),
  last_name: z.string().max(MAX_NAME_LENGTH).optional(),
});

export const PATCH = withRoute(async (req: Request) => {
  const gated = await gate(req);
  if (gated instanceof Response) return gated;
  if (gated.kind !== "user") {
    return Response.json(
      { error: "user_session_required", message: "Sign in to edit your profile." },
      { status: 401 },
    );
  }

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = Patch.safeParse(parsed.data);
  if (!body.success) {
    return Response.json(
      { error: "invalid_body", message: body.error.issues[0]?.message ?? "invalid body" },
      { status: 400 },
    );
  }

  const admin = getSupabaseAdmin();
  const { data: current } = await admin.auth.admin.getUserById(gated.userId);
  const existing = (current?.user?.user_metadata ?? {}) as Record<string, unknown>;

  // `updateUserById` replaces `user_metadata` wholesale, so the patch is
  // merged onto what is already there — `signup_complete` and the invite
  // provenance live in the same object and must survive a rename.
  const merged = {
    ...existing,
    ...nameMetadata({
      first_name:
        body.data.first_name !== undefined
          ? body.data.first_name
          : ((existing.first_name as string | null | undefined) ?? null),
      last_name:
        body.data.last_name !== undefined
          ? body.data.last_name
          : ((existing.last_name as string | null | undefined) ?? null),
    }),
  };

  const { data: updated, error } = await admin.auth.admin.updateUserById(
    gated.userId,
    { user_metadata: merged },
  );
  if (error) {
    return Response.json(
      { error: "update_failed", message: error.message },
      { status: 400 },
    );
  }

  const user = updated?.user ?? null;
  const me: Me = {
    user: meUserFrom(gated.userId, user),
    is_admin: isAdminEmail(user?.email ?? null),
    has_password: hasPasswordIdentity(user),
    can_create_organization: mayCreateOrganization(user?.email ?? null),
  };
  return Response.json(me);
});
