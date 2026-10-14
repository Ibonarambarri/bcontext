/**
 * Retired address, kept so old links and bookmarks keep working: `/agents`
 * became the `agents` system view. The redirect runs client-side because the
 * old `?tab=` query decides which surface (agents, tools, a Nexo's
 * integrations) it
 * lands on, and only the browser has the query and the hash.
 */
import { LegacyAdminRedirect } from "@/components/legacy-admin-redirect";

export const metadata = {
  title: "Agents — Bcontext",
};

export default async function AgentsPage({
  params,
}: {
  params: Promise<{ org: string; ws: string }>;
}) {
  const { org, ws } = await params;
  return <LegacyAdminRedirect workspace={{ org, slug: ws }} source="agents" />;
}
