/**
 * Anonymous Supabase client — no session, nothing persisted.
 *
 * The only caller is the password change, which has to prove a person knows
 * their current password and has no other way to ask: `signInWithPassword`
 * is the check. Doing it on the request-scoped client would swap the
 * caller's session for a fresh one mid-request; doing it here throws the
 * session away with the client.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseAnonKey, supabaseUrl } from "@/lib/env";

export function getSupabaseAnon(): SupabaseClient {
  const url = supabaseUrl();
  const key = supabaseAnonKey();
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
