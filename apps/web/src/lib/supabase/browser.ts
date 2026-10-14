/**
 * The browser-side Supabase Auth client, one per tab.
 *
 * Session only — sign-in, token refresh, `onAuthStateChange` — never
 * `.from(...)`: data goes through the API. Heavy (~55 KB gzip), so shell
 * components reach it through `browser-lazy.ts` rather than importing this
 * module statically.
 */
import { createBrowserClient } from "@supabase/ssr";
import { authCookieName, publicEnv } from "@/lib/public-env";

let client: ReturnType<typeof createBrowserClient> | null = null;

/** The memoised client; created on first use with the public URL and anon key. */
export function getSupabaseBrowser() {
  if (client) return client;
  const env = publicEnv();
  client = createBrowserClient(env.supabaseUrl, env.supabaseAnonKey, {
    cookieOptions: { name: authCookieName() },
  });
  return client;
}
