/**
 * Retired address: `/browse` is what the workspace overview (`/w/<org>/<ws>`)
 * replaced. Client-side redirect so the query string and hash survive.
 */
import { LegacyBrowseRedirect } from "@/components/legacy-browse-redirect";

export default async function LegacyBrowsePage({ params }: { params: Promise<{ org: string; ws: string }> }) {
  const { org, ws } = await params;
  return <LegacyBrowseRedirect workspace={{ org, slug: ws }} />;
}
