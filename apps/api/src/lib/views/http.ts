/**
 * The HTTP edge of saved views: what every `/api/views/*` route does before
 * and after calling the store. Routes stay one-liners; auth, reach and error
 * mapping live here once.
 */
import type { Scope } from "@bcontext-dev/contract/auth/scopes";
import { openWorkspace } from "@/lib/auth/workspace";
import type { Verb } from "@/lib/auth/grants";
import type { Storage } from "@/lib/storage";
import { viewPrincipal } from "./access";
import { ViewConflictError, ViewForbiddenError, ViewNotFoundError } from "./store";
import type { ViewPrincipal } from "@bcontext-dev/contract/views/types";

/**
 * Shared entry point for the five `/api/views/*` routes.
 *
 * It must open the workspace through `openWorkspace` so the returned storage
 * carries the caller's reach: `resolveViewQuery` reads through whatever
 * storage it is handed, and a principal narrowed to one tag would otherwise
 * get the whole workspace back from an empty query. The route-level guard
 * that enforces scoped storage scans `src/app/api/**` only, so this file has
 * to keep that promise on its own.
 *
 * `scope` is what the bearer token must carry; `verb` is what the caller's
 * grant in this workspace must allow. They are checked separately, so a
 * mutating route has to pass both `nodes:write` and `"write"` — the scope
 * alone lets a read-only member through, which is what `views_write` over
 * MCP refuses.
 */
export async function resolveViewRequest(
  req: Request,
  workspace: string,
  scope: Scope,
  verb: Verb = "read",
): Promise<{ storage: Storage; principal: ViewPrincipal } | { response: Response }> {
  const ctx = await openWorkspace(req, workspace, verb, { scope });
  if (ctx instanceof Response) return { response: ctx };
  return { storage: ctx.storage, principal: await viewPrincipal(ctx.actor, ctx.storage) };
}

/** Store errors → HTTP; `null` means "not ours, let the route's 500 path have it". */
export function viewErrorResponse(error: unknown): Response | null {
  if (error instanceof ViewNotFoundError) return Response.json({ error: "not_found" }, { status: 404 });
  if (error instanceof ViewForbiddenError) return Response.json({ error: "forbidden", message: error.message }, { status: 403 });
  if (error instanceof ViewConflictError) return Response.json({ error: "conflict", message: error.message, current_version: error.currentVersion, expected_version: error.expectedVersion }, { status: 409 });
  return null;
}
