/**
 * POST /api/oauth/revoke — RFC 7009 token revocation.
 *
 * `authorizationServerMetadata` advertises this endpoint, and for a while it
 * was advertised without existing: clients discovered it and got a 404, so a
 * user disconnecting an MCP client left live tokens behind. Keep the two in
 * step.
 *
 * Accepts either token type. Revoking a refresh token takes down its whole
 * rotation family (RFC 7009 §2.1 explicitly allows revoking related
 * tokens, and "disconnect this client" is what callers actually mean).
 *
 * Per §2.2 the response is 200 for an unknown or already-revoked token —
 * only a bad client or malformed request errors, so the endpoint cannot be
 * used to probe which tokens exist.
 */
import { withRoute } from "@/lib/route";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { OAuthError, revokeToken } from "@/lib/auth/oauth";

interface RevokeRequest {
  token?: string;
  token_type_hint?: string;
  client_id?: string;
  client_secret?: string;
}

/** Mirrors the /token endpoint: body credentials or HTTP Basic. */
function parseBasicAuth(req: Request): {
  clientId?: string;
  clientSecret?: string;
} {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Basic\s+(.+)$/i.exec(header.trim());
  const encoded = match?.[1];
  if (!encoded) return {};
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return {};
  }
  const sep = decoded.indexOf(":");
  if (sep === -1) return {};
  const decodeField = (v: string): string => {
    try {
      return decodeURIComponent(v.replace(/\+/g, " "));
    } catch {
      return v;
    }
  };
  return {
    clientId: decodeField(decoded.slice(0, sep)),
    clientSecret: decodeField(decoded.slice(sep + 1)),
  };
}

async function readBody(req: Request): Promise<RevokeRequest> {
  const ct = req.headers.get("content-type") ?? "";
  let body: RevokeRequest = {};
  if (ct.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(await req.text());
    body = {
      token: params.get("token") ?? undefined,
      token_type_hint: params.get("token_type_hint") ?? undefined,
      client_id: params.get("client_id") ?? undefined,
      client_secret: params.get("client_secret") ?? undefined,
    };
  } else if (ct.includes("application/json")) {
    body = (await req.json()) as RevokeRequest;
  }
  const basic = parseBasicAuth(req);
  return {
    ...body,
    client_id: body.client_id ?? basic.clientId,
    client_secret: body.client_secret ?? basic.clientSecret,
  };
}

export const POST = withRoute(async (req: Request) => {
  const body = await readBody(req);
  if (!body.token || !body.client_id || !body.client_secret) {
    return Response.json(
      { error: "invalid_request", error_description: "missing required field" },
      { status: 400 },
    );
  }
  try {
    await revokeToken(getSupabaseAdmin(), {
      token: body.token,
      clientId: body.client_id,
      clientSecret: body.client_secret,
    });
  } catch (err) {
    if (err instanceof OAuthError) {
      return Response.json(err.toBody(), { status: 400 });
    }
    throw err;
  }
  // §2.2: success is an empty 200, whether or not the token existed.
  return new Response(null, {
    status: 200,
    headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
  });
});
