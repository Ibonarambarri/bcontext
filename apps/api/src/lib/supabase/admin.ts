/**
 * Service-role Supabase client.
 *
 * Kept apart from the request-bound client (`./request`) so the pg-boss
 * worker and the error collector can import it without dragging in cookie
 * handling.
 *
 * Bypasses RLS. Use ONLY in trusted server contexts (background pipelines,
 * admin operations, the agent surface once the caller is authorized).
 */
import { supabaseUrl } from "@/lib/env";

/** A fresh service-role client per call; cheap, and no session to share. */
export function getSupabaseAdmin() {
  const url = supabaseUrl();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing SUPABASE_SERVICE_ROLE_KEY or SUPABASE_URL",
    );
  }
  // Lazy `require` (rather than a static import) is deliberate: it keeps the
  // return type untyped, which the ~60 call sites rely on — a fully-generic
  // `SupabaseClient` makes PostgREST's embedded-relation inference reject
  // casts that have compiled for two years.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createClient } = require("@supabase/supabase-js");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
