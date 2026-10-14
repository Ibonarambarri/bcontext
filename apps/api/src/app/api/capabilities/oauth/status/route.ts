/**
 * One OAuth authorization attempt, as the Connections page polls it.
 *
 *   GET    /api/capabilities/oauth/status?workspace_id=…&attempt_id=…
 *   DELETE /api/capabilities/oauth/status?workspace_id=…&attempt_id=…   cancel
 *
 * Session-cookie owner|admin (`capabilityAdmin`); the attempt must belong to
 * the same person. DELETE cancels and then answers with the resulting status,
 * so the client has one shape to read either way.
 */
import { z } from "zod";
import { capabilityAdmin } from "@/lib/capabilities/admin";
import {
  cancelOAuthAttempt,
  CapabilityOAuthError,
  getOAuthAttemptStatus,
} from "@/lib/capabilities/oauth";
import { withRoute } from "@/lib/route";

const QuerySchema = z.object({
  workspace_id: z.string().uuid(),
  attempt_id: z.string().uuid(),
});

export const GET = withRoute(async (req: Request) => handle(req, false));
export const DELETE = withRoute(async (req: Request) => handle(req, true));

async function handle(req: Request, cancel: boolean): Promise<Response> {
  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    workspace_id: url.searchParams.get("workspace_id"),
    attempt_id: url.searchParams.get("attempt_id"),
  });
  if (!parsed.success) {
    return Response.json({ error: "invalid_request", issues: parsed.error.flatten() }, { status: 400 });
  }
  const access = await capabilityAdmin(req, parsed.data.workspace_id);
  if (access instanceof Response) return access;

  try {
    if (cancel) {
      await cancelOAuthAttempt({
        workspaceId: parsed.data.workspace_id,
        userId: access.userId,
        attemptId: parsed.data.attempt_id,
      });
    }
    const result = await getOAuthAttemptStatus({
      workspaceId: parsed.data.workspace_id,
      userId: access.userId,
      attemptId: parsed.data.attempt_id,
    });
    return Response.json({
      attempt_id: result.id,
      status: result.status,
      scopes: result.scopes,
      expires_at: result.expiresAt,
      connected_at: result.connectedAt,
      error_code: result.errorCode,
    });
  } catch (error) {
    if (error instanceof CapabilityOAuthError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.httpStatus });
    }
    return Response.json({ error: "oauth_status_failed", message: "Unable to read provider authorization" }, { status: 500 });
  }
}
