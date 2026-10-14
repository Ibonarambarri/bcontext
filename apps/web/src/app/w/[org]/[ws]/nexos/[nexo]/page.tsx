/**
 * `/w/<org>/<ws>/nexos/<nexo>` — one Nexo's page: chat, inbox, activity and
 * setup as tabs (`?tab=`, `?section=`). `<nexo>` is an id or
 * `general`, which `NexoDetail` resolves through the list. `useSearchParams`
 * inside needs the Suspense boundary.
 */
import { Suspense } from "react";
import { NexoDetail } from "@/components/nexos/nexo-detail";

export const metadata = { title: "Nexo — Bcontext" };

export default async function Page({
  params,
}: {
  params: Promise<{ org: string; ws: string; nexo: string }>;
}) {
  const { org, ws, nexo } = await params;
  return (
    <Suspense fallback={null}>
      <NexoDetail workspace={{ org, slug: ws }} nexoRef={decodeURIComponent(nexo)} />
    </Suspense>
  );
}
