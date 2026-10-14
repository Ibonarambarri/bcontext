/**
 * Gate and shell for `/admin/*`, the platform operator's panel.
 *
 * Every page under here is a Server Component that reads `/api/admin/*`
 * through `@/web/api-client`; the API decides who is an admin and this
 * layout only asks. Non-admins get a 404, never a 403, so the panel's
 * existence is not advertised.
 */
import { notFound, redirect } from "next/navigation";
import { isSupabaseConfigured } from "@bcontext-dev/contract/env";
import { whoami } from "@/web/me";
import { AdminShell } from "@/components/admin/admin-shell";

/**
 * Hidden admin area. Reachable only by typing the URL — no public nav link.
 * Access is decided by the API (`GET /api/me`, backed by the allowlist in
 * bcontext-api's `src/lib/admin/access.ts`: ADMIN_EMAILS env, nobody when
 * unset); the web side only sees the answer. Move to a roles table the day the allowlist
 * outgrows an env var.
 */
export const metadata = {
  title: "Admin — Bcontext",
  robots: { index: false, follow: false },
};

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!isSupabaseConfigured()) {
    // Demo / unconfigured deploys must not expose the surface at all.
    notFound();
  }
  const me = await whoami();
  if (!me) {
    redirect("/login?next=/admin");
  }
  if (!me.is_admin) {
    // Pretend the route doesn't exist for everyone else — no 403 banner so
    // we don't advertise that an admin panel exists at all.
    notFound();
  }
  return <AdminShell>{children}</AdminShell>;
}
