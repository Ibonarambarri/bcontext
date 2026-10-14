/**
 * `/w/<org>/<ws>/nexo` — retired address of the assistant's page. The
 * general Nexo's chat is the Chat tab of its page in Nexos now; the open
 * conversation (`?c=`) travels with the redirect so shared links still land
 * on it.
 */
import { redirect } from "next/navigation";
import { nexoPath } from "@/lib/view-shell";

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; ws: string }>;
  searchParams: Promise<{ c?: string | string[] }>;
}) {
  const { org, ws } = await params;
  const { c } = await searchParams;
  redirect(nexoPath({ org, slug: ws }, typeof c === "string" ? c : undefined));
}
