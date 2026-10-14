/**
 * Environment names that outlived Next.
 *
 * `NEXT_PUBLIC_*` meant "inlined into the browser bundle at `next build`".
 * Nothing in this image is a Next process (API, worker, error collector), so
 * each variable has a plain name that wins when set; the `NEXT_PUBLIC_`
 * spelling is still read as a fallback for deployments that predate it.
 *
 * Retirement: the `NEXT_PUBLIC_*` fallbacks are read until **2026-12-31**;
 * after that only the plain names are read.
 *
 * Read at call time, not at import: tests set and unset these per case.
 */

/** `SUPABASE_URL` — the Kong/API gateway of the Supabase stack. */
export function supabaseUrl(): string | undefined {
  return process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
}

/**
 * `SUPABASE_PUBLIC_URL` — the same gateway as the browser reaches it. In a
 * single-host install (docker compose) the API talks to Kong over the
 * internal network (`http://kong:8000`) while browsers reach it through the
 * public origin, so links that leave the server (storage object URLs) and the
 * session cookie's name are built from this one. Unset = `SUPABASE_URL`.
 */
export function supabasePublicUrl(): string | undefined {
  return process.env.SUPABASE_PUBLIC_URL || supabaseUrl();
}

/**
 * A URL the Supabase client built against `SUPABASE_URL`, rewritten onto
 * `SUPABASE_PUBLIC_URL`. Identity when they are the same or either is unset.
 */
export function toPublicSupabaseUrl(url: string): string {
  const internal = supabaseUrl()?.replace(/\/$/, "");
  const pub = supabasePublicUrl()?.replace(/\/$/, "");
  if (!internal || !pub || internal === pub || !url.startsWith(internal)) return url;
  return pub + url.slice(internal.length);
}

/**
 * Name of the session cookie `@supabase/ssr` reads: `sb-<first label of the
 * gateway host>-auth-token`, from the PUBLIC gateway, which is the one the
 * browser (and so the web app) derived it from. Without this the API would
 * look for `sb-kong-auth-token` while the browser set `sb-<domain>-…`.
 */
export function supabaseAuthCookieName(): string | undefined {
  const pub = supabasePublicUrl();
  if (!pub) return undefined;
  try {
    return `sb-${new URL(pub).hostname.split(".")[0]}-auth-token`;
  } catch {
    return undefined;
  }
}

/** `SUPABASE_ANON_KEY` — the anon JWT, used to validate user sessions. */
export function supabaseAnonKey(): string | undefined {
  return process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
}

/**
 * `APP_URL` — where the product's web app lives, for links that leave the
 * server and for the browser origin the API trusts. `NEXT_PUBLIC_SITE_URL`
 * is the older spelling of the same thing and retires on the same date.
 */
export function appUrl(): string | undefined {
  return (
    process.env.APP_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.NEXT_PUBLIC_SITE_URL
  );
}

/** `ALLOWED_ORIGINS` — extra browser origins (comma-separated) the API accepts writes from. */
export function allowedOrigins(): string | undefined {
  return process.env.ALLOWED_ORIGINS ?? process.env.NEXT_PUBLIC_ALLOWED_ORIGINS;
}

/** Supabase is configured when the gateway URL and the service-role key are both present. */
export function supabaseConfigured(): boolean {
  return Boolean(supabaseUrl() && process.env.SUPABASE_SERVICE_ROLE_KEY);
}
