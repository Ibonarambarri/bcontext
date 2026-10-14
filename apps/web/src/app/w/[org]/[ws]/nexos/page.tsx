/**
 * `/w/<org>/<ws>/nexos` — the workspace's team of Nexos, plus the external
 * agents and tool providers they work with. Everything comes from the shell's
 * providers and the API, so the route is only a mount point.
 */
import { NexosPage } from "@/components/nexos/nexos-page";

export const metadata = { title: "Nexos — Bcontext" };

export default async function Page({ params }: { params: Promise<{ org: string; ws: string }> }) {
  const { org, ws } = await params;
  return <NexosPage workspace={{ org, slug: ws }} />;
}
