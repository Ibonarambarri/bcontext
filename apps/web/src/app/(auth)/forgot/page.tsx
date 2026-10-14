/** `/forgot` — password recovery. Server Component: only decides who sees the form. */
import { redirect } from "next/navigation";
import type { Route } from "next";
import { isSupabaseConfigured } from "@bcontext-dev/contract/env";
import { getSession } from "@/web/session";
import { ForgotForm } from "./forgot-form";

export const metadata = {
  title: "Reset password · Bcontext",
  robots: { index: false, follow: false },
};

export default async function ForgotPage() {
  if (isSupabaseConfigured()) {
    const supabase = await getSession();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    // Already signed in — change the password directly instead.
    if (user) redirect("/auth/reset" as Route);
  } else {
    // No Supabase Auth to reset a password against — the hub is where a
    // demo deployment sends people instead.
    redirect("/workspaces");
  }
  return <ForgotForm />;
}
