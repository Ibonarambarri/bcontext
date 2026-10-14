/**
 * Retired address: `/nodes`, like `/browse`, now lands on the workspace
 * overview (`/w/<org>/<ws>`). Client-side redirect so the query survives.
 */
import { LegacyBrowseRedirect } from "@/components/legacy-browse-redirect";

export default async function LegacyNodesPage({ params }: { params: Promise<{ org: string; ws: string }> }) {
  const { org, ws } = await params;
  return <LegacyBrowseRedirect workspace={{ org, slug: ws }} />;
}
