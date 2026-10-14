/**
 * Retired address: `/views` no longer has a page of its own. Saved views are
 * reached from the shell, so the route sends people to the workspace overview.
 */
import type { Route } from "next";
import { redirect } from "next/navigation";
import { workspacePath } from "@/web/workspace-url";

export default async function ViewsPage({ params }: { params: Promise<{ org: string; ws: string }> }) {
  const { org, ws } = await params;
  redirect(workspacePath({ org, slug: ws }) as Route);
}
