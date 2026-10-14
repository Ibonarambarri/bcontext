/**
 * Next 16 `proxy` (the middleware successor): the session gate in front of
 * the product.
 *
 * Only `/w/:path*` is matched. Everything else either is public (`/login`,
 * `/start`, `/docs`), decides for itself with `getSession()` (the hub, the
 * admin pages), or is an API path that Next rewrites to the API before this
 * runs and that the API authenticates on its own. Without a session the
 * person is sent to `/login?next=<path>`; the page they wanted is not
 * rendered at all, so nothing behind `/w` ever streams to a stranger.
 *
 * The Supabase client is built on the request's cookies and writes back to
 * the *response*: `auth.getUser()` may refresh an expiring token, and this is
 * the one place in a request where the refreshed cookie can be set before
 * any Server Component reads it. Skips entirely when Supabase Auth is not
 * configured (demo deployments have no sessions to gate on).
 */
import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { authCookieName, publicEnv, serverSupabaseUrl, supabaseAuthConfigured } from "@/lib/public-env";

function supabaseConfigured(): boolean {
  return supabaseAuthConfigured();
}

/** Session gate for `/w/*`. The `server-timing` header exposes its cost in devtools. */
export async function proxy(req: NextRequest) {

  if (!supabaseConfigured()) {
    return NextResponse.next();
  }

  const started = performance.now();
  let res = NextResponse.next({ request: req });

  const supabase = createServerClient(
    serverSupabaseUrl(),
    publicEnv().supabaseAnonKey,
    {
      cookieOptions: { name: authCookieName() },
      cookies: {
        get(name: string) {
          return req.cookies.get(name)?.value;
        },
        set(name: string, value: string, options: CookieOptions) {
          res.cookies.set({ name, value, ...options });
        },
        remove(name: string, options: CookieOptions) {
          res.cookies.set({ name, value: "", ...options });
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", req.nextUrl.pathname);
    const redirect = NextResponse.redirect(url);
    redirect.headers.set("server-timing", `proxy-auth;dur=${(performance.now() - started).toFixed(1)}`);
    return redirect;
  }

  res.headers.set("server-timing", `proxy-auth;dur=${(performance.now() - started).toFixed(1)}`);
  return res;
}

export const config = {
  matcher: ["/w/:path*"],
};
