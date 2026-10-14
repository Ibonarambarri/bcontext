/**
 * Liveness/readiness probe for uptime monitoring (Better Stack).
 *
 * Point a Better Stack monitor at <APP_URL>/api/health. Returns 200 when the
 * app is healthy and its critical dependency (Supabase, when configured) is
 * reachable; 503 when the dependency is down so the monitor opens an incident.
 *
 * Deliberately NOT wrapped with `withRoute` — uptime pings hit this every
 * 30–60s and we don't want a request.started/completed log line per ping.
 */
import { isSupabaseConfigured } from "@bcontext-dev/contract/env";
import { supabaseAnonKey, supabaseUrl } from "@/lib/env";

export const dynamic = "force-dynamic";

async function checkSupabase(): Promise<"ok" | "down"> {
  const url = supabaseUrl();
  const anon = supabaseAnonKey();
  if (!url || !anon) return "down";
  try {
    const res = await fetch(`${url}/auth/v1/health`, {
      headers: { apikey: anon },
      signal: AbortSignal.timeout(2500),
      cache: "no-store",
    });
    return res.ok ? "ok" : "down";
  } catch {
    return "down";
  }
}

export async function GET(): Promise<Response> {
  const db = isSupabaseConfigured() ? await checkSupabase() : "skipped";
  const healthy = db !== "down";

  return Response.json(
    {
      status: healthy ? "ok" : "degraded",
      db,
      commit: process.env.SOURCE_COMMIT?.slice(0, 7) ?? null,
      ts: new Date().toISOString(),
    },
    {
      status: healthy ? 200 : 503,
      headers: { "Cache-Control": "no-store, max-age=0" },
    },
  );
}
