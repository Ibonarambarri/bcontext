/**
 * GET /api/capabilities/oauth/callback — where the provider's authorization
 * server sends the browser back. Opened in the popup `/oauth/start` spawned,
 * so the answer is a tiny self-contained HTML page (strict CSP, no scripts)
 * rather than JSON; the page that opened the popup learns the outcome by
 * polling `/oauth/status`.
 *
 * The session cookie identifies the person and has to match the one who
 * started the attempt (`completeOAuthAuthorization` checks); `state` is the
 * attempt lookup and the CSRF guard. Errors from the provider and from the
 * exchange all render the same failure page — the detail is on the attempt.
 */
import { completeOAuthAuthorization } from "@/lib/capabilities/oauth";
import { appUrl as configuredAppUrl } from "@/lib/env";
import { getSupabaseForRequest } from "@/lib/supabase/request";
import { withRoute } from "@/lib/route";

export const GET = withRoute(async (req: Request) => {
  const url = new URL(req.url);
  const state = url.searchParams.get("state");
  if (!state) return popupPage(false, "The provider did not return a valid authorization state.", 400);

  const supabase = getSupabaseForRequest(req);
  const { data } = await supabase.auth.getUser();
  if (!data.user) return popupPage(false, "Your Bcontext session expired. Sign in and try again.", 401);

  try {
    await completeOAuthAuthorization({
      state,
      code: url.searchParams.get("code"),
      error: url.searchParams.get("error"),
      errorDescription: url.searchParams.get("error_description"),
      appOrigin: canonicalAppOrigin(),
      userId: data.user.id,
    });
    return popupPage(true, "Authorization complete. Bcontext is importing this provider's tools.");
  } catch {
    return popupPage(false, "Bcontext could not complete authorization. Return to Tools and try again.", 400);
  }
});

function canonicalAppOrigin(): string {
  const configured = configuredAppUrl();
  if (!configured) throw new Error("OAuth callback origin is unavailable");
  return new URL(configured).origin;
}

function popupPage(ok: boolean, message: string, status = 200): Response {
  const title = ok ? "Provider connected" : "Authorization failed";
  const icon = ok ? "✓" : "!";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>html{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0a;color:#f4f2ed;font:14px ui-sans-serif,system-ui}.card{width:min(360px,calc(100vw - 40px));padding:28px;border:1px solid #302f2b;border-radius:16px;background:#121210;text-align:center}.icon{width:40px;height:40px;margin:0 auto 16px;display:grid;place-items:center;border:1px solid #44423c;border-radius:12px;font-size:20px}h1{font-size:17px;margin:0 0 8px}p{margin:0;color:#aaa69d;line-height:1.55}</style></head><body><main class="card"><div class="icon">${icon}</div><h1>${title}</h1><p>${message}</p></main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    },
  });
}
