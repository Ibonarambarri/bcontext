/**
 * The way back to a Nexo after a native OAuth hop.
 *
 * Slack, GitHub, Linear and Notion leave the app for the provider and come
 * back through the API's callback, which lands on the app root with
 * `?<provider>=connected` and nothing else — it cannot know which Nexo asked.
 * So Setup → Sources writes the Nexo's page (with `connect=<connector>`) here
 * just before the redirect, and the launcher, mounted on every workspace
 * page, takes the person there once they are back. Same tab, so
 * sessionStorage; a stale note (the person abandoned the hop) expires.
 *
 * Storage can be missing or throw (private mode, blocked site data): then
 * the person simply lands where the callback sends them.
 */
const KEY = "bcontext:nexo-connect-return";
const TTL_MS = 15 * 60 * 1000;

interface Pending {
  href: string;
  at: number;
}

/** Remember to come back to `href` after the hop. */
export function rememberConnectReturn(href: string): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify({ href, at: Date.now() } satisfies Pending));
  } catch {
    // No storage: the callback's own landing is the fallback.
  }
}

/** The page to go back to, once: reading it forgets it. Null when there is none or it went stale. */
export function takeConnectReturn(now = Date.now()): string | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(KEY);
    const pending = JSON.parse(raw) as Partial<Pending>;
    if (typeof pending.href !== "string" || typeof pending.at !== "number") return null;
    if (now - pending.at > TTL_MS || !pending.href.startsWith("/w/")) return null;
    return pending.href;
  } catch {
    return null;
  }
}
