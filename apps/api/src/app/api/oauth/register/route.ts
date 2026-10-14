/**
 * POST /api/oauth/register
 *
 * Dynamic client registration per RFC 7591. Open endpoint — any caller
 * can register an MCP client. We rate-limit aggressively and store
 * `registered_by` from the session when present.
 *
 * Body: { client_name, redirect_uris[], scope?, client_uri?, logo_uri?, tos_uri?, policy_uri? }
 * Returns: { client_id, client_secret, ... } — secret shown ONCE.
 */
import { z } from "zod";
import { gate } from "@/lib/auth/require";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { registerClient } from "@/lib/auth/oauth";

const Schema = z.object({
  client_name: z.string().min(1).max(120),
  redirect_uris: z.array(z.string().url()).min(1).max(5),
  scope: z.string().max(200).optional(),
  client_uri: z.string().url().optional(),
  logo_uri: z.string().url().optional(),
  tos_uri: z.string().url().optional(),
  policy_uri: z.string().url().optional(),
});

export const POST = withRoute(async (req: Request) => {
  // RFC 7591 dynamic client registration must be reachable by anonymous
  // MCP clients (Claude Code/Desktop/Cursor) so they can bootstrap the
  // OAuth flow before they have any credentials. We still run origin-guard
  // + IP rate-limit through gate() to throttle abuse.
  const gated = await gate(req, undefined, { allowAnonymous: true });
  if (gated instanceof Response) return gated;
  const userId = gated.kind === "user" ? gated.userId : null;

  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = Schema.safeParse(body.data);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_client_metadata", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  try {
    const result = await registerClient(getSupabaseAdmin(), {
      ...parsed.data,
      registered_by: userId,
    });
    return Response.json(result, { status: 201 });
  } catch (err) {
    return Response.json(
      {
        error: "invalid_redirect_uri",
        error_description: err instanceof Error ? err.message : String(err),
      },
      { status: 400 },
    );
  }
});
