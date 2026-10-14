/**
 * `/w/<org>/<ws>/s/<slug>` — the human-readable address of a node. It only
 * redirects: the id-based `/n/<id>` URL is canonical and survives renames.
 */
import type { Route } from "next";
import { notFound, redirect } from "next/navigation";
import { apiJsonOrNull } from "@/web/api-client";
import { listNodeSummaries } from "@/web/workspace";
import { workspacePath, workspaceApiRef } from "@/web/workspace-url";

/**
 * Resolve a slug-based URL (`/w/<org>/<ws>/s/<slug>`) to the canonical
 * id-based URL (`/w/<org>/<ws>/n/<id>`). Tries the current `slug`, then
 * any historical slug recorded in `data.previous_slugs[]`.
 */
export default async function SlugRedirectPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; ws: string; slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { org, ws, slug } = await params;
  const workspace = { org, slug: ws };

  // Fast path: current slugs resolve from the index the layout already
  // fetched for this request — no second call. Only a miss (a historical
  // slug after a rename, or a workspace the person cannot see) asks the API,
  // which is the only side that can read `previous_slugs`.
  const summaries = await listNodeSummaries(workspace);
  if (!summaries) notFound();
  let node: { id: string } | null = summaries.find((n) => n.slug === slug) ?? null;
  if (!node) {
    node = await apiJsonOrNull<{ id: string; slug: string }>(
      `/api/nodes/by-slug/${encodeURIComponent(slug)}?workspace=${encodeURIComponent(workspaceApiRef(workspace))}`,
    );
  }
  if (!node) notFound();
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, item);
  }
  redirect(`${workspacePath(workspace, `n/${encodeURIComponent(node.id)}`)}${query.size ? `?${query}` : ""}` as Route);
}
