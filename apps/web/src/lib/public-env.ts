/**
 * The instance settings the web app needs at RUNTIME, so one image serves
 * any domain: the Supabase gateway (server-side and public), the anon key,
 * the realtime WebSocket origin and the Nango hosts.
 *
 * Why not plain `NEXT_PUBLIC_*`: those are inlined into the bundle at
 * `next build`, so a prebuilt image would carry somebody else's domain and
 * keys. Here the server reads its environment when the request runs, and
 * the browser reads `window.__BCONTEXT_ENV__`, which `/env.js`
 * (`src/app/env.js/route.ts`) sets before hydration. The inlined
 * `NEXT_PUBLIC_*` values stay as the last fallback, so `next dev` with a
 * `.env.local` keeps working unchanged.
 *
 * Variables (runtime, server side):
 *   SUPABASE_URL          gateway as this process reaches it (http://kong:8000)
 *   SUPABASE_PUBLIC_URL   gateway as the browser reaches it (https://ctx.example.com)
 *   SUPABASE_ANON_KEY     anon JWT
 *   REALTIME_PUBLIC_URL   API origin as a WebSocket URL (wss://ctx.example.com)
 *   NANGO_PUBLIC_HOST, NANGO_CONNECT_URL   self-hosted Nango, when used
 *
 * Must not break: the session cookie name is derived from the PUBLIC gateway
 * on both sides (`authCookieName`), or the browser and the server would read
 * and write different cookies.
 */

export interface PublicEnv {
  supabaseUrl: string;
  supabaseAnonKey: string;
  realtimeUrl: string;
  nangoHost: string;
  nangoConnectUrl: string;
}

declare global {
  interface Window {
    __BCONTEXT_ENV__?: Partial<PublicEnv>;
  }
}

/** Read without letting the bundler inline it: a computed key is never replaced at build. */
function runtime(name: string): string {
  const env: Record<string, string | undefined> = process.env;
  return (env[name] ?? "").trim();
}

const trim = (s: string | undefined) => (s ?? "").trim().replace(/\/+$/, "");

/** What the browser should use, computed on the server from its environment. */
export function serverPublicEnv(): PublicEnv {
  return {
    supabaseUrl: trim(
      runtime("SUPABASE_PUBLIC_URL") || runtime("NEXT_PUBLIC_SUPABASE_URL") || runtime("SUPABASE_URL"),
    ),
    supabaseAnonKey: runtime("SUPABASE_ANON_KEY") || runtime("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    realtimeUrl: trim(runtime("REALTIME_PUBLIC_URL") || runtime("NEXT_PUBLIC_REALTIME_URL")),
    nangoHost: trim(runtime("NANGO_PUBLIC_HOST") || runtime("NEXT_PUBLIC_NANGO_HOST")),
    nangoConnectUrl: trim(runtime("NANGO_CONNECT_URL") || runtime("NEXT_PUBLIC_NANGO_CONNECT_URL")),
  };
}

/** Build-time values, the fallback for `next dev` and older deployments. */
function inlined(): PublicEnv {
  return {
    supabaseUrl: trim(process.env.NEXT_PUBLIC_SUPABASE_URL),
    supabaseAnonKey: (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "").trim(),
    realtimeUrl: trim(process.env.NEXT_PUBLIC_REALTIME_URL),
    nangoHost: trim(process.env.NEXT_PUBLIC_NANGO_HOST),
    nangoConnectUrl: trim(process.env.NEXT_PUBLIC_NANGO_CONNECT_URL),
  };
}

/** The public settings, on either side. */
export function publicEnv(): PublicEnv {
  if (typeof window === "undefined") return serverPublicEnv();
  const fromServer = window.__BCONTEXT_ENV__ ?? {};
  const base = inlined();
  return {
    supabaseUrl: fromServer.supabaseUrl || base.supabaseUrl,
    supabaseAnonKey: fromServer.supabaseAnonKey || base.supabaseAnonKey,
    realtimeUrl: fromServer.realtimeUrl || base.realtimeUrl,
    nangoHost: fromServer.nangoHost || base.nangoHost,
    nangoConnectUrl: fromServer.nangoConnectUrl || base.nangoConnectUrl,
  };
}

/** Whether Supabase Auth is configured at all (demo deployments have none). */
export function supabaseAuthConfigured(): boolean {
  const env = publicEnv();
  return Boolean(env.supabaseUrl && env.supabaseAnonKey);
}

/**
 * The gateway a server-side Supabase client should call: the internal URL
 * when there is one (inside docker compose the public origin may not even
 * resolve), the public one otherwise.
 */
export function serverSupabaseUrl(): string {
  return trim(runtime("SUPABASE_URL")) || publicEnv().supabaseUrl;
}

/**
 * `sb-<first label of the public gateway host>-auth-token`, the name
 * `@supabase/ssr` would pick from the public URL. Passed explicitly to every
 * client so a server calling `http://kong:8000` reads the cookie the browser
 * wrote for `https://ctx.example.com`.
 */
export function authCookieName(): string | undefined {
  const url = publicEnv().supabaseUrl;
  if (!url) return undefined;
  try {
    return `sb-${new URL(url).hostname.split(".")[0]}-auth-token`;
  } catch {
    return undefined;
  }
}
