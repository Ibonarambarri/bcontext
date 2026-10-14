/**
 * Microsoft Graph helpers shared by the Microsoft 365 adapters (Teams,
 * Outlook, OneDrive, SharePoint). All of them are Nango aliases of the
 * `microsoft` provider, whose proxy base is https://graph.microsoft.com, so
 * every request path below starts at `/v1.0/...`.
 */
import type { NangoClient, ProxyResponse } from "@/lib/nango/client";

export const GRAPH_BASE = "https://graph.microsoft.com";

/** Turn an `@odata.nextLink` (absolute) into a proxy path, or null when absent. */
export function graphNextPath(nextLink: string | undefined | null): string | null {
  if (!nextLink) return null;
  if (nextLink.startsWith(GRAPH_BASE)) return nextLink.slice(GRAPH_BASE.length);
  try {
    const u = new URL(nextLink);
    return `${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}

/** OData datetime literal for `$filter` — no quotes, ISO in UTC. */
export function odataSince(since: Date): string {
  return since.toISOString();
}

export interface GraphPage<T> {
  value?: T[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

/**
 * Walk a Graph collection page by page (cap `maxPages`), calling `onItem`
 * until it returns false or the pages run out. The first request carries
 * `query`; follow-ups use the server's nextLink verbatim.
 */
export async function graphWalk<T>(
  client: NangoClient,
  providerConfigKey: string,
  connectionId: string,
  path: string,
  query: Record<string, string | number | boolean | undefined>,
  onItem: (item: T) => boolean,
  opts: { maxPages?: number; headers?: Record<string, string> } = {},
): Promise<{ pages: number; last: ProxyResponse<GraphPage<T>> | null }> {
  const maxPages = opts.maxPages ?? 5;
  let nextPath: string | null = path;
  let first = true;
  let pages = 0;
  let last: ProxyResponse<GraphPage<T>> | null = null;
  while (nextPath && pages < maxPages) {
    const res: ProxyResponse<GraphPage<T>> = await client.proxy<GraphPage<T>>({
      method: "GET",
      providerConfigKey,
      connectionId,
      path: nextPath,
      ...(first ? { query } : {}),
      ...(opts.headers ? { headers: opts.headers } : {}),
    });
    last = res;
    pages += 1;
    if (!res.ok) throw new Error(`graph ${path} failed (${res.status})`);
    for (const item of res.data?.value ?? []) {
      if (!onItem(item)) return { pages, last };
    }
    nextPath = graphNextPath(res.data?.["@odata.nextLink"]);
    first = false;
  }
  return { pages, last };
}

/** Display name of a Graph identity set (`from.user`, `lastModifiedBy.user`, …). */
export function graphIdentity(identity: unknown): string | undefined {
  if (!identity || typeof identity !== "object") return undefined;
  const i = identity as { user?: { displayName?: string; email?: string }; application?: { displayName?: string }; displayName?: string };
  return i.user?.displayName ?? i.user?.email ?? i.application?.displayName ?? i.displayName;
}
