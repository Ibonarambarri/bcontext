/**
 * POST /api/oauth/token
 *
 * Token endpoint. Implements the `authorization_code` and `refresh_token`
 * grants. Refresh tokens rotate on every use and are only issued for
 * workspace-scoped grants; user-scoped tokens have no TTL at all and
 * therefore omit `expires_in` entirely (see RedeemedToken for why 0 is not
 * a valid stand-in).
 *
 * An optional `resource` (RFC 8707) names the MCP endpoint the token is
 * for; it has to be this server's and, for a workspace-scoped grant, the
 * workspace the grant was made for — otherwise `invalid_target`.
 *
 * Accepts form-encoded body (per OAuth 2.1) or JSON for convenience.
 */
import { withRoute } from "@/lib/route";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { OAuthError, redeemCode, refreshAccessToken } from "@/lib/auth/oauth";
import { parseMcpResource } from "@/lib/mcp/resource";

interface TokenRequest {
  grant_type?: string;
  code?: string;
  client_id?: string;
  client_secret?: string;
  redirect_uri?: string;
  code_verifier?: string;
  refresh_token?: string;
  scope?: string;
  resource?: string;
}

/**
 * Client credentials may arrive via `client_secret_post` (in the body) or
 * `client_secret_basic` (HTTP Basic header). ChatGPT's MCP connector uses
 * Basic; Claude Code uses the body. Per RFC 6749 §2.3.1 the Basic payload
 * is `base64(urlencode(client_id) ":" urlencode(client_secret))`.
 */
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

async function readForm(req: Request): Promise<TokenRequest> {
  const ct = req.headers.get("content-type") ?? "";
  let body: TokenRequest = {};
  if (ct.includes("application/x-www-form-urlencoded")) {
    const text = await req.text();
    const params = new URLSearchParams(text);
    body = {
      grant_type: params.get("grant_type") ?? undefined,
      code: params.get("code") ?? undefined,
      client_id: params.get("client_id") ?? undefined,
      client_secret: params.get("client_secret") ?? undefined,
      redirect_uri: params.get("redirect_uri") ?? undefined,
      code_verifier: params.get("code_verifier") ?? undefined,
      refresh_token: params.get("refresh_token") ?? undefined,
      scope: params.get("scope") ?? undefined,
      resource: params.get("resource") ?? undefined,
    };
  } else if (ct.includes("application/json")) {
    body = (await req.json()) as TokenRequest;
  }

  // Fall back to HTTP Basic credentials when the body omits them.
  const basic = parseBasicAuth(req);
  return {
    ...body,
    client_id: body.client_id ?? basic.clientId,
    client_secret: body.client_secret ?? basic.clientSecret,
  };
}

export const POST = withRoute(async (req: Request) => {
  const body = await readForm(req);
  if (
    body.grant_type !== "authorization_code" &&
    body.grant_type !== "refresh_token"
  ) {
    return Response.json(
      { error: "unsupported_grant_type" },
      { status: 400 },
    );
  }

  // Read once for both grants: a resource that is not one of ours is
  // refused before any credential is looked at.
  const resource = parseMcpResource(req, body.resource);
  if (resource === null) {
    return Response.json(
      {
        error: "invalid_target",
        error_description: "resource must be this server's /mcp or /mcp/<organization>/<workspace> URL",
      },
      { status: 400 },
    );
  }

  if (body.grant_type === "refresh_token") {
    if (!body.refresh_token || !body.client_id || !body.client_secret) {
      return Response.json(
        {
          error: "invalid_request",
          error_description: "missing required field",
        },
        { status: 400 },
      );
    }
    try {
      const token = await refreshAccessToken(getSupabaseAdmin(), {
        refreshToken: body.refresh_token,
        clientId: body.client_id,
        clientSecret: body.client_secret,
        scope: body.scope,
        resource,
      });
      return Response.json(token, {
        headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
      });
    } catch (err) {
      if (err instanceof OAuthError) {
        return Response.json(err.toBody(), { status: 400 });
      }
      throw err;
    }
  }

  if (
    !body.code ||
    !body.client_id ||
    !body.client_secret ||
    !body.redirect_uri ||
    !body.code_verifier
  ) {
    return Response.json(
      { error: "invalid_request", error_description: "missing required field" },
      { status: 400 },
    );
  }
  try {
    const token = await redeemCode(getSupabaseAdmin(), {
      code: body.code,
      clientId: body.client_id,
      clientSecret: body.client_secret,
      redirectUri: body.redirect_uri,
      codeVerifier: body.code_verifier,
      resource,
    });
    return Response.json(token, {
      headers: {
        "Cache-Control": "no-store",
        Pragma: "no-cache",
      },
    });
  } catch (err) {
    if (err instanceof OAuthError) {
      return Response.json(err.toBody(), { status: 400 });
    }
    throw err;
  }
});
