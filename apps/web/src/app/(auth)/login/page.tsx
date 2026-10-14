/**
 * `/login`. A person who already has a session is sent on (to `next` when it
 * is a path of our own, else the hub) instead of seeing the form again.
 */
import { redirect } from "next/navigation";
import type { Route } from "next";
import { isSupabaseConfigured } from "@bcontext-dev/contract/env";
import { getSession } from "@/web/session";
import { AuthForm } from "../auth-form";

export const metadata = {
  title: "Sign in · Bcontext",
};

/** Same-site paths only: `?next=` comes from the URL and is followed by a redirect. */
function safeNext(value: string | string[] | undefined): string | null {

  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  return raw;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = (await searchParams) ?? {};
  const next = safeNext(sp.next);

  if (isSupabaseConfigured()) {
    const supabase = await getSession();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) redirect((next ?? "/workspaces") as Route);
  }
  return <AuthForm next={next ?? undefined} />;
}
