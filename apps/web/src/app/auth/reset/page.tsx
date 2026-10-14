import { redirect } from "next/navigation";
import type { Route } from "next";
import { isSupabaseConfigured } from "@bcontext-dev/contract/env";
import { getSession } from "@/web/session";
import { AuthShell } from "@/components/auth/AuthShell";
import { ResetForm } from "./reset-form";

export const metadata = {
  title: "New password · Bcontext",
  robots: { index: false, follow: false },
};

/**
 * Recovery-session landing. The reset email links to
 * /auth/confirm?next=/auth/reset — the confirm bridge writes the session
 * cookie from the URL fragment and forwards here. Also reachable directly
 * by a signed-in user who wants to change their password.
 */
export default async function ResetPage() {
  if (!isSupabaseConfigured()) {
    redirect("/");
  }
  const supabase = await getSession();
  const { data } = await supabase.auth.getUser();
  if (!data.user) {
    // No recovery session (link expired or replayed) — start over.
    redirect("/forgot" as Route);
  }

  return (
    <AuthShell>
      <ResetForm email={data.user.email ?? ""} />
    </AuthShell>
  );
}
