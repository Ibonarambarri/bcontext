/**
 * The workspace shell: sidebar, switcher, presence and the per-workspace accent,
 * around every page under `/w/<org>/<ws>`.
 *
 * Everything it shows comes from the API through `@/web/workspace` (memoised
 * per request, so the page below reuses the same tree) and the only Supabase
 * call is `auth.getUser()` for the presence cursor. Membership is not checked
 * here: a workspace the person cannot see is absent from the list and 404s on
 * the tree, and either is `notFound()`.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { WorkspaceShell } from "@/components/workspace-shell";
import type { CurrentUser } from "@/components/workspace-context";
import { explicitGradientFor } from "@bcontext-dev/contract/workspace-gradients";
import { workspaceAccentCss } from "@/lib/workspace-accent";
import { displayName, userColor } from "@/lib/collab/user-color";
import { getSession } from "@/web/session";
import {
  findWorkspace,
  listNodeSummaries,
  listOrganizations,
  listWorkspaces,
} from "@/web/workspace";
import { showOrgLayer } from "@/lib/org-layer";

// Force the layout to be dynamic on every render — the sidebar's `nodes`
// list reflects live user activity (new meetings, renames, deletes) and
// must not be served from a static cache. Without this Next.js may treat
// the layout as cacheable in PPR contexts, causing the tree to drift from
// reality until a hard reload.
export const dynamic = "force-dynamic";

/**
 * Two workspaces called `docs` are told apart by the company they belong to,
 * so the tab says which one this is: "Docs · Acme".
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ org: string; ws: string }>;
}): Promise<Metadata> {
  const { org, ws } = await params;
  const workspace = await findWorkspace({ org, slug: ws });
  if (!workspace) return {};
  return { title: `${workspace.name} · ${workspace.organization.name}` };
}

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ org: string; ws: string }>;
}) {
  const { org, ws } = await params;
  const address = { org, slug: ws };

  // Three independent reads, so they overlap — the workspace list and the
  // organizations behind it are one cached fetch, not two. The API already narrowed the
  // first two to the person behind the cookie: a workspace they are not a
  // member of is absent from the switcher and 404s on the tree, which is
  // the same "nothing here" the layout showed when it did the check itself.
  const [workspaces, organizations, nodes, currentUser] = await Promise.all([
    listWorkspaces(),
    listOrganizations(),
    listNodeSummaries(address),
    signedInUser(),
  ]);
  const workspace = workspaces.find(
    (item) => item.slug === ws && item.organization.slug === org,
  );
  if (!workspace || !nodes) notFound();

  // Anonymous fallback: still let the collab provider paint a cursor so
  // demo-mode and signed-out previews show live activity between two tabs.
  // The id is stable per-browser via localStorage so reconnects keep colour.
  const finalUser: CurrentUser =
    currentUser ?? buildAnonymousPlaceholder();

  // Per-workspace accent, server-rendered so it ships in the first HTML
  // chunk and is live BEFORE first paint (client-side stamping flashed the
  // neutral blue for a frame). Only an explicitly stored gradient re-tints;
  // hash-fallback identities keep the neutral product accent. The <style>
  // node is React-managed: it updates in-commit when switching workspaces
  // and unmounts with the layout, reverting the hub/login to neutral.
  const accentGradient = explicitGradientFor(workspace.metadata ?? null);

  return (
    <>
      {accentGradient ? (
        <style
          data-ws-accent={accentGradient.id}
          dangerouslySetInnerHTML={{ __html: workspaceAccentCss(accentGradient) }}
        />
      ) : null}
      <WorkspaceShell
        org={org}
        workspaceSlug={ws}
        workspace={workspace}
        workspaces={workspaces}
        orgLayer={showOrgLayer({ organizations, workspaces })}
        nodes={nodes}
        currentUser={finalUser}
      >
        {children}
      </WorkspaceShell>
    </>
  );
}

/**
 * Who is signed in, for the presence cursor — session only, never data. A
 * deployment without Supabase Auth (demo) has no session to read and gets
 * the guest placeholder, exactly as the demo backend did.
 */
async function signedInUser(): Promise<CurrentUser | null> {
  try {
    const supabase = await getSession();
    const { data } = await supabase.auth.getUser();
    if (!data.user) return null;
    const email = data.user.email ?? null;
    return {
      id: data.user.id,
      email,
      name: displayName(email ?? data.user.id),
      color: userColor(data.user.id),
      anonymous: false,
    };
  } catch {
    return null;
  }
}

function buildAnonymousPlaceholder(): CurrentUser {
  // Server-rendered seed; the editor's client-side hook upgrades this to a
  // localStorage-backed handle on mount so the colour/name stay stable.
  const id = "anon-server";
  return {
    id,
    email: null,
    name: "Guest",
    color: userColor(id),
    anonymous: true,
  };
}
