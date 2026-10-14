/**
 * POST /api/capabilities/oauth/start — begin authorizing an OAuth-protected
 * provider (an MCP server behind an authorization server, typically).
 *
 * The Connections page calls it before registering the capability, then opens
 * `authorization_url` in a popup and polls `/oauth/status` with `attempt_id`.
 * Session-cookie owner|admin (`capabilityAdmin`). The redirect URI is built
 * from the configured app origin and must be https outside local dev — an
 * http callback would hand the authorization code to whoever sits on the
 * wire — and `allowed_hosts` must contain the endpoint host so the later
 * token exchange stays inside the egress pin.
 */
import { z } from "zod";
import { appUrl as configuredAppUrl } from "@/lib/env";
import { capabilityAdmin, parseJson } from "@/lib/capabilities/admin";
import {
  CapabilityOAuthError,
  startOAuthAuthorization,
} from "@/lib/capabilities/oauth";
import { withRoute } from "@/lib/route";

const StartSchema = z.object({
  workspace_id: z.string().uuid(),
  endpoint_url: z.string().url().refine((value) => new URL(value).protocol === "https:", "HTTPS required"),
  allowed_hosts: z.array(z.string().min(1).max(253)).min(1).max(20),
}).superRefine((value, ctx) => {
  const endpointHost = normalizeHost(new URL(value.endpoint_url).hostname);
  if (!value.allowed_hosts.some((host) => normalizeHost(host) === endpointHost)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["allowed_hosts"], message: "must include the endpoint host" });
  }
});

export const POST = withRoute(async (req: Request) => {
  const input = await parseJson(req, StartSchema);
  if (input instanceof Response) return input;
  const access = await capabilityAdmin(req, input.workspace_id);
  if (access instanceof Response) return access;

  try {
    const result = await startOAuthAuthorization({
      workspaceId: input.workspace_id,
      userId: access.userId,
      endpointUrl: input.endpoint_url,
      allowedHosts: input.allowed_hosts,
      appOrigin: canonicalAppOrigin(),
    });
    return Response.json({
      attempt_id: result.attemptId,
      authorization_url: result.authorizationUrl,
      authorization_host: new URL(result.authorizationUrl).hostname,
      expires_at: result.expiresAt,
      scopes: result.scopes,
    }, { status: 201 });
  } catch (error) {
    return oauthError(error);
  }
});

function canonicalAppOrigin(): string {
  const configured = configuredAppUrl();
  if (!configured) throw new CapabilityOAuthError("oauth_origin_unavailable", "OAuth is not configured on this Bcontext deployment", 503);
  const url = new URL(configured);
  if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new CapabilityOAuthError("oauth_origin_invalid", "OAuth callback origin must use HTTPS", 503);
  }
  return url.origin;
}

function normalizeHost(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function oauthError(error: unknown): Response {
  if (error instanceof CapabilityOAuthError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.httpStatus });
  }
  return Response.json({ error: "oauth_start_failed", message: "Unable to start provider authorization" }, { status: 502 });
}
