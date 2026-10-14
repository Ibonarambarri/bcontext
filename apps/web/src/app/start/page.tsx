import { redirect } from "next/navigation";
import type { Route } from "next";
import { isSupabaseConfigured } from "@bcontext-dev/contract/env";
import type { WorkspacesResponse } from "@bcontext-dev/contract/workspaces";
import { getSession } from "@/web/session";
import { apiJson } from "@/web/api-client";
import { whoami } from "@/web/me";
import { AuthShell } from "@/components/auth/AuthShell";
import { SignupForm, OrganizationForm } from "./start-form";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Start · Bcontext",
  robots: { index: false, follow: false },
};

interface Props {
  searchParams: Promise<{ email?: string; error?: string }>;
}

/**
 * `/start` — where "Start now" lands, and where a signed-in person with no
 * organization is sent to create one.
 *
 * Signed out: one form, account plus organization name (`SignupForm`). On an
 * instance whose organizations are created by its administrators the API
 * refuses the signup and the form says so.
 *
 * Signed in: somebody who already belongs to an organization has nothing to
 * start and goes to the hub; somebody with none names one here
 * (`OrganizationForm`) when they may, which is also where the confirmation
 * email ends up (via `/workspaces`). Rendering a signup form to a person
 * with a session is how one human ends up with two accounts.
 *
 * `?email=` lets a marketing page hand over an address typed in its hero
 * without talking to the API.
 */
export default async function StartPage({ searchParams }: Props) {
  if (!isSupabaseConfigured()) redirect("/workspaces");

  const { email, error } = await searchParams;
  const { data } = await (await getSession()).auth.getUser();

  if (data.user) {
    const { organizations, workspaces } =
      await apiJson<WorkspacesResponse>("/api/workspaces");
    if (organizations.length > 0 || workspaces.length > 0) {
      redirect("/workspaces" as Route);
    }
    const me = await whoami();
    if (!me?.can_create_organization) redirect("/workspaces" as Route);
    return (
      <AuthShell>
        <OrganizationForm initialError={error || undefined} />
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <SignupForm prefillEmail={email?.includes("@") ? email : undefined} />
    </AuthShell>
  );
}
