/**
 * `/admin` — the operator's overview: usage and AI cost from
 * `/api/admin/metrics`, plus the per-organization health list that says who
 * needs a message today. Server Component; the numbers are drawn by
 * `AdminDashboard`.
 */
import { redirect } from "next/navigation";
import type { Route } from "next";
import { isSupabaseConfigured } from "@bcontext-dev/contract/env";
import { whoami } from "@/web/me";
import { apiJson, ApiError } from "@/web/api-client";
import type { DashboardMetrics } from "@bcontext-dev/contract/admin-metrics";
import type {
  AdminOrgHealth,
  AdminOrgHealthList,
} from "@bcontext-dev/contract/admin-orgs";
import { AdminPage } from "@/components/admin/admin-shell";
import { AdminDashboard } from "@/components/admin/admin-dashboard";

export const metadata = {
  title: "Admin · Overview — Bcontext",
  description: "Usage and AI cost dashboard.",
};

export default async function AdminHomePage() {
  if (!isSupabaseConfigured()) redirect("/login" as Route);
  const me = await whoami();
  if (!me) redirect("/login?next=/admin" as Route);
  if (!me.is_admin) redirect("/workspaces" as Route);

  const initial = await apiJson<DashboardMetrics>("/api/admin/metrics?months=6");

  /**
   * Who needs a message today is read beside the numbers, not instead of
   * them — and it is the half an operator can act on, so it must not be able
   * to take the dashboard down with it when the route is unavailable.
   */
  let health: AdminOrgHealth[] = [];
  let healthError: string | null = null;
  try {
    const list = await apiJson<AdminOrgHealthList>(
      "/api/admin/organizations/health",
    );
    health = list.organizations;
  } catch (err) {
    healthError =
      err instanceof ApiError && err.status === 404
        ? "not available yet"
        : err instanceof Error
          ? err.message
          : "unavailable";
  }

  return (
    <AdminPage>
      <AdminDashboard
        initial={initial}
        health={health}
        healthError={healthError}
      />
    </AdminPage>
  );
}
