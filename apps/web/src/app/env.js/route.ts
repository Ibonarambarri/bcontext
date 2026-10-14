/**
 * GET /env.js — the instance's public settings as a script that sets
 * `window.__BCONTEXT_ENV__` (`@/lib/public-env`). Loaded by the root layout
 * before hydration, so a prebuilt image learns its domain and anon key from
 * the container's environment instead of from `next build`.
 *
 * Only public values: the anon key is meant for browsers, nothing else here
 * is a secret. Never cached, so a restart with new settings takes effect on
 * the next page load.
 */
import { serverPublicEnv } from "@/lib/public-env";

export const dynamic = "force-dynamic";

export function GET() {
  const body = `window.__BCONTEXT_ENV__=${JSON.stringify(serverPublicEnv()).replace(/</g, "\\u003c")};`;
  return new Response(body, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
