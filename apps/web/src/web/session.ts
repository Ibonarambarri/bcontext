/**
 * The person behind the current Next request — session only.
 *
 * This is the one Supabase client the web side keeps: it reads the auth
 * cookie through `next/headers` and answers `auth.getUser()`,
 * `auth.signInWithPassword()` and the rest of the session API. It is
 * Supabase's SDK talking to Supabase Auth, not our domain — the web app does
 * not need our API to know who is signed in.
 *
 * What it must never be used for is `.from(...)`. Data goes through the API
 * (`@/web/api-client`), where the person's grant is applied; a page that
 * queried tables with this client would be one line away from bypassing it.
 * The guard test `web-speaks-http.test.ts` keeps that from happening.
 */
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import { authCookieName, publicEnv, serverSupabaseUrl } from "@/lib/public-env";

/** A request-scoped Supabase Auth client over the incoming cookie jar. */
export async function getSession() {
  const cookieStore = await cookies();
  return createServerClient(
    serverSupabaseUrl(),
    publicEnv().supabaseAnonKey,
    {
      cookieOptions: { name: authCookieName() },
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        // Next forbids mutating cookies from a Server Component; Supabase SSR
        // calls set/remove during token refresh on every auth lookup. Swallow
        // it here — the refresh lands in the next Server Action or Route
        // Handler, where mutation is allowed.
        set(name: string, value: string, options: CookieOptions) {
          try {
            cookieStore.set({ name, value, ...options });
          } catch {
            /* Server Component context */
          }
        },
        remove(name: string, options: CookieOptions) {
          try {
            cookieStore.set({ name, value: "", ...options });
          } catch {
            /* Server Component context */
          }
        },
      },
    },
  );
}
