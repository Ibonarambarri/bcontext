/**
 * Who the current request belongs to, as the API sees it.
 *
 * `GET /api/me` answers with the person and whether they are a platform
 * admin. Pages that gate on either ask here; a missing session is a plain
 * `null`, not an exception, because "not signed in" is a normal branch for
 * them (redirect to /login) rather than a failure.
 */
import { apiJson, ApiError } from "./api-client";
import type { Me } from "@bcontext-dev/contract/me";

export async function whoami(): Promise<Me | null> {
  try {
    return await apiJson<Me>("/api/me");
  } catch (err) {
    if (sessionMissing(err)) return null;
    throw err;
  }
}

/**
 * "There is no person behind this request", as routes say it. In production
 * that is a 401; in development the gate's demo escape hatch turns a missing
 * session into an anonymous actor and user-only routes answer 403
 * `user_session_required` instead. Either way the page's move is the same:
 * send them to /login.
 */
function sessionMissing(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  return err.status === 401 || (err.status === 403 && err.message === "user_session_required");
}
