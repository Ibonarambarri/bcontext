import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expireAbandonedOAuthAttempts } from "./oauth-expiry";

function client(batches: number[], error: { message: string } | null = null) {
  const rpc = vi.fn(async () => {
    if (error) return { data: null, error };
    const n = batches.shift() ?? 0;
    return { data: Array.from({ length: n }, (_, i) => ({ attempt_id: `a${i}`, secret_ref: `vault:${i}` })), error: null };
  });
  return { rpc, client: { rpc } as unknown as SupabaseClient };
}

const NOW = () => new Date("2026-10-14T10:00:00.000Z");

describe("expireAbandonedOAuthAttempts", () => {
  it("expires across every workspace in one call when the batch is not full", async () => {
    const { rpc, client: c } = client([3]);
    await expect(expireAbandonedOAuthAttempts(c, NOW)).resolves.toEqual({ expired: 3, batches: 1 });
    expect(rpc).toHaveBeenCalledWith("expire_capability_oauth_attempts", {
      p_workspace_id: null,
      p_now: "2026-10-14T10:00:00.000Z",
      p_limit: 100,
    });
  });

  it("keeps going while batches come back full, and stops at the cap", async () => {
    const { rpc, client: c } = client([100, 100, 7]);
    await expect(expireAbandonedOAuthAttempts(c, NOW)).resolves.toEqual({ expired: 207, batches: 3 });
    expect(rpc).toHaveBeenCalledTimes(3);

    const full = client(Array.from({ length: 20 }, () => 100));
    await expect(expireAbandonedOAuthAttempts(full.client, NOW)).resolves.toEqual({ expired: 1000, batches: 10 });
  });

  it("throws on a database error so pg-boss retries the job", async () => {
    const { client: c } = client([], { message: "boom" });
    await expect(expireAbandonedOAuthAttempts(c, NOW)).rejects.toThrow(/boom/);
  });
});
