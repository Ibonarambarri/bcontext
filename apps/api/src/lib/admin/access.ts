/**
 * Admin gating. The admin surface is restricted to the emails in the
 * `ADMIN_EMAILS` env var (comma-separated, case-insensitive). Unset or empty
 * means nobody is an admin: the panel fails closed, so a fresh self-hosted
 * instance never grants it to an address baked into the code. Single source
 * of truth for `GET /api/me` (which the /admin pages ask) and every
 * `/api/admin/*` route. Move to a roles table the day the allowlist outgrows
 * an env var.
 */
import { gate } from "@/lib/auth/require";
import { getSupabaseForRequest } from "@/lib/supabase/request";

function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return adminEmails().includes(email.toLowerCase());
}

export interface AdminActor {
  userId: string;
  email: string;
}

/**
 * The person behind a session-cookied request, if they are a platform admin.
 * Goes through `gate` first so admin routes keep the same-origin guard and the
 * rate limit every other route has; only a cookie session can be an admin —
 * a bearer token, however scoped, never is. 401 without a session, 403 with
 * one that is not on the allowlist.
 */
export async function gateAdmin(req: Request): Promise<AdminActor | Response> {
  const gated = await gate(req);
  if (gated instanceof Response) return gated;
  if (gated.kind !== "user") {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  // `gate` resolved the id; the allowlist is by email, which only the auth
  // server can vouch for.
  const { data } = await getSupabaseForRequest(req).auth.getUser();
  const email = data.user?.email ?? null;
  if (!email || !isAdminEmail(email)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  return { userId: gated.userId, email };
}
