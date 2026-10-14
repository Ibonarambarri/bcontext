/**
 * Supabase client for the person behind a `Request`, read from its cookies.
 *
 * Reads only. Supabase SSR asks to write refreshed tokens back via `set`; a
 * route handler has nowhere to put them without threading the response through,
 * and the browser client refreshes on its own (the web app renews the session
 * on its side). So an API call sees the current session and never extends it —
 * which is the right shape for an API.
 */
import { createServerClient } from "@supabase/ssr";
import { supabaseAnonKey, supabaseAuthCookieName, supabaseUrl } from "@/lib/env";

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[name] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

/**
 * Cookie-scoped client: RLS applies as the signed-in person. Callers that
 * need the identity go through `@/lib/auth` rather than reading it off this.
 */
export function getSupabaseForRequest(req: Request) {
  const jar = parseCookies(req.headers.get("cookie"));
  return createServerClient(
    supabaseUrl()!,
    supabaseAnonKey()!,
    {
      cookieOptions: { name: supabaseAuthCookieName() },
      cookies: {
        get(name: string) {
          return jar[name];
        },
        set() {
          // See header: an API response does not extend the session.
        },
        remove() {},
      },
    },
  );
}
