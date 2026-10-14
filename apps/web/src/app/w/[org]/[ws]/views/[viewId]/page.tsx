/**
 * Retired address: saved views moved from `/views/<id>` to `/v/<slug-or-id>`.
 * Server-side redirect that carries the query string (filters, selection)
 * across unchanged.
 */
import type { Route } from "next";
import { redirect } from "next/navigation";
import { workspacePath } from "@/web/workspace-url";

export default async function SavedViewPage({ params, searchParams }: { params: Promise<{ org: string; ws: string; viewId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { org, ws, viewId } = await params;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, item);
  }
  redirect(`${workspacePath({ org, slug: ws }, `v/${encodeURIComponent(viewId)}`)}${query.size ? `?${query}` : ""}` as Route);
}
