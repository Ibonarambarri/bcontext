/**
 * Sweep of abandoned capability OAuth attempts — the worker job
 * `capability.oauth-expire`.
 *
 * An attempt holds OAuth material (PKCE verifier, and after the callback the
 * tokens) in Vault until it is attached or expires. Browser-side cleanup is
 * best effort, so a popup somebody closed must not be the only thing standing
 * between a refresh token and the Vault forever: every five minutes this asks
 * `expire_capability_oauth_attempts` (migration 0034) to expire what is past
 * `expires_at` across every workspace. The function locks, marks and deletes
 * the Vault secret in one transaction, 100 rows per call, so this loops a
 * bounded number of batches and leaves the rest to the next tick.
 *
 * Called only by the worker (`src/lib/queue/handlers.ts`); it used to be a
 * pg_cron job, which a Supabase without pg_cron cannot run (migration 0097
 * removes it). Must stay idempotent: two replicas may tick at once, and
 * `for update skip locked` in the SQL is what makes that harmless.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** The SQL function caps a call at 100 rows. */
const BATCH = 100;
/** Enough for a burst of abandoned flows; anything left goes next tick. */
const MAX_BATCHES = 10;

export interface ExpireOAuthAttemptsResult extends Record<string, unknown> {
  expired: number;
  batches: number;
}

export async function expireAbandonedOAuthAttempts(
  client: SupabaseClient,
  now: () => Date = () => new Date(),
): Promise<ExpireOAuthAttemptsResult> {
  let expired = 0;
  let batches = 0;
  while (batches < MAX_BATCHES) {
    const { data, error } = await client.rpc("expire_capability_oauth_attempts", {
      p_workspace_id: null,
      p_now: now().toISOString(),
      p_limit: BATCH,
    });
    if (error) throw new Error(`expire_capability_oauth_attempts: ${error.message}`);
    batches += 1;
    const n = Array.isArray(data) ? data.length : 0;
    expired += n;
    if (n < BATCH) break;
  }
  return { expired, batches };
}
