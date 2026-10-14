/**
 * Soft-revoke a user-scoped token. Requires an authenticated Supabase
 * session — bearer tokens cannot revoke other tokens. RLS on
 * `user_api_tokens` enforces ownership (`user_id = auth.uid()`).
 */
import { z } from "zod";
import { getSupabaseForRequest } from "@/lib/supabase/request";
import { revokeUserToken } from "@/lib/auth/tokens";
import { withRoute } from "@/lib/route";

const ParamsSchema = z.object({ id: z.string().uuid() });

export const DELETE = withRoute(async (
  _req: Request,
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

  const supabase = getSupabaseForRequest(_req);
  const { data: session } = await supabase.auth.getUser();
  if (!session.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    await revokeUserToken(supabase, parsed.data.id, session.user.id);
    return Response.json({ ok: true });
  } catch (err) {
    const message = (err as Error).message;
    if (/row-level security|permission denied/i.test(message)) {
      return Response.json(
        { error: "forbidden", message: "not your token" },
        { status: 403 },
      );
    }
    return Response.json(
      { error: "internal", message },
      { status: 500 },
    );
  }
});
