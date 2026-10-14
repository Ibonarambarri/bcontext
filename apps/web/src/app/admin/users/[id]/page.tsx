import Link from "next/link";
import type { Route } from "next";
import { ArrowLeft } from "lucide-react";
import { apiJson, ApiError } from "@/web/api-client";
import type {
  AdminUserAgent,
  AdminUserDetail,
  AdminUserWorkspace,
} from "@bcontext-dev/contract/admin-orgs";
import { Alert, Chip, Table } from "@heroui/react";
import { AdminPage } from "@/components/admin/admin-shell";
import { Empty, Section } from "@/components/admin/detail-ui";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Admin · User — Bcontext",
};

/** Fixed locale: the server and the browser must agree or hydration breaks. */
function day(iso: string): string {
  return iso.slice(0, 10);
}

function ago(iso: string | null, never: string): string {
  if (!iso) return never;
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 30) return `${d}d ago`;
  return day(iso);
}

/**
 * One person, everything the platform knows about them.
 *
 * The list answers "who is here"; this answers the questions that follow. The
 * order is the order they get asked: who they are and whether they ever got
 * in, then where they can reach — because access somebody has and cannot
 * explain is the reason this page exists — then what is acting in their name,
 * then when any of it last moved.
 */
export default async function AdminUserPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let user: AdminUserDetail | null = null;
  let error: string | null = null;
  try {
    user = await apiJson<AdminUserDetail>(
      `/api/admin/users/${encodeURIComponent(id)}`,
    );
  } catch (err) {
    // A 404 is either a person who is not there or a route that is not there
    // yet, and the panel cannot tell them apart — so it says the softer of
    // the two rather than showing an error page over a deploy in flight.
    error =
      err instanceof ApiError && err.status === 404
        ? "not available yet"
        : err instanceof Error
          ? err.message
          : "unavailable";
  }

  return (
    <AdminPage title={user?.email ?? id}>
      <Link
        href={"/admin/users" as Route}
        className="mb-5 inline-flex items-center gap-1.5 text-[12px] text-[var(--ink-3)] transition-colors hover:text-[var(--ink)]"
      >
        <ArrowLeft size={12} /> All users
      </Link>

      {user === null ? (
        <Alert role="alert" status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>
              Couldn&apos;t load this person: {error}.
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : (
        <>
          <Identity user={user} />

          <Section
            title="Workspaces"
            hint="Everywhere this person can read. A workspace reached through an organization role is not in its members list, which is why access nobody can find is usually here."
          >
            {user.workspaces.length === 0 ? (
              <Empty>
                Nowhere yet — an account with no workspace has nothing to open.
              </Empty>
            ) : (
              <Table>
                <Table.ScrollContainer>
                  <Table.Content
                    aria-label="Workspaces"
                    className="min-w-[640px] whitespace-nowrap"
                  >
                    <Table.Header>
                      <Table.Column isRowHeader>Workspace</Table.Column>
                      <Table.Column>Organization</Table.Column>
                      <Table.Column>Role</Table.Column>
                      <Table.Column>Through</Table.Column>
                    </Table.Header>
                    <Table.Body>
                      {user.workspaces.map((ws: AdminUserWorkspace) => (
                        <Table.Row key={ws.id} id={ws.id}>
                          <Table.Cell>
                            <div className="text-[12.5px] text-[var(--ink)]">
                              {ws.name}
                            </div>
                            <div className="font-mono text-[10.5px] text-[var(--ink-mute)]">
                              /w/{ws.slug}
                            </div>
                          </Table.Cell>
                          <Table.Cell>
                            <Link
                              href={`/admin/orgs/${ws.organization_id}` as Route}
                              className="text-[var(--ink-2)] underline-offset-2 hover:text-[var(--ink)] hover:underline"
                            >
                              {ws.organization_slug}
                            </Link>
                          </Table.Cell>
                          <Table.Cell>{ws.role}</Table.Cell>
                          <Table.Cell
                            className={
                              ws.via_org_role ? "" : "text-[var(--ink-mute)]"
                            }
                          >
                            {ws.via_org_role ? "organization role" : "membership"}
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table.Content>
                </Table.ScrollContainer>
              </Table>
            )}
          </Section>

          <Section
            title="Agents"
            hint="What this person connected — the things acting in their name."
          >
            {user.agents.length === 0 ? (
              <Empty>
                Nothing connected. An agent connecting is the moment the
                product starts being used.
              </Empty>
            ) : (
              <Table>
                <Table.ScrollContainer>
                  <Table.Content
                    aria-label="Agents"
                    className="min-w-[640px] whitespace-nowrap"
                  >
                    <Table.Header>
                      <Table.Column isRowHeader>Agent</Table.Column>
                      <Table.Column>Provider</Table.Column>
                      <Table.Column>Workspaces</Table.Column>
                      <Table.Column>Connected</Table.Column>
                      <Table.Column>Last used</Table.Column>
                    </Table.Header>
                    <Table.Body>
                      {user.agents.map((agent: AdminUserAgent) => (
                        <Table.Row key={agent.id} id={agent.id}>
                          <Table.Cell className="text-[var(--ink)]">
                            {agent.name}
                          </Table.Cell>
                          <Table.Cell
                            className={
                              agent.provider ? "" : "text-[var(--ink-mute)]"
                            }
                          >
                            {agent.provider ?? "none"}
                          </Table.Cell>
                          <Table.Cell className="tabular-nums">
                            {agent.workspace_count}
                          </Table.Cell>
                          <Table.Cell className="tabular-nums text-[var(--ink-3)]">
                            {day(agent.created_at)}
                          </Table.Cell>
                          {/* A token that was minted and never used is its own
                              fact — a connection somebody set up and abandoned
                              — so it is named rather than left as a dash. */}
                          <Table.Cell
                            className={
                              agent.last_used_at
                                ? "tabular-nums text-[var(--ink-3)]"
                                : "text-[var(--ink-mute)]"
                            }
                          >
                            {ago(agent.last_used_at, "never used")}
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table.Content>
                </Table.ScrollContainer>
              </Table>
            )}
          </Section>

          <Section
            title="Organizations"
            hint="Who they belong to, and as what."
          >
            {user.orgs.length === 0 ? (
              <Empty>
                No organization — nothing to sign in to.
              </Empty>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {user.orgs.map((org) => (
                  <Link key={org.id} href={`/admin/orgs/${org.id}` as Route}>
                    <Chip variant="secondary">
                      {org.name} · {org.role}
                    </Chip>
                  </Link>
                ))}
              </div>
            )}
          </Section>
        </>
      )}
    </AdminPage>
  );
}

/**
 * Who they are and whether the handover ever happened.
 *
 * Signing up, signing in and doing something are three different events and
 * only the last means the account is alive — so they sit side by side rather
 * than being folded into one "active" word that would hide which of the three
 * is missing.
 */
function Identity({ user }: { user: AdminUserDetail }) {
  const state = !user.confirmed
    ? "invited, no password"
    : !user.last_sign_in_at
      ? "never signed in"
      : "active";

  return (
    <div className="mb-8 grid grid-cols-2 gap-x-6 gap-y-3 rounded-md border border-[var(--line)] bg-[var(--paper-2)] px-4 py-3 sm:grid-cols-4">
      <Fact label="Status" value={state} dim={state === "active"} />
      <Fact label="Joined" value={day(user.created_at)} />
      <Fact
        label="Last signed in"
        value={ago(user.last_sign_in_at, "never")}
        dim={!user.last_sign_in_at}
      />
      <Fact
        label="Last activity"
        value={ago(user.last_activity_at, "never")}
        dim={!user.last_activity_at}
      />
      <div className="col-span-2 sm:col-span-4">
        <Fact label="User id" value={user.id} />
      </div>
    </div>
  );
}

function Fact({
  label,
  value,
  dim,
}: {
  label: string;
  value: string;
  dim?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--ink-mute)]">
        {label}
      </div>
      <div
        className={`truncate font-mono text-[12px] ${
          dim ? "text-[var(--ink-mute)]" : "text-[var(--ink-2)]"
        }`}
      >
        {value}
      </div>
    </div>
  );
}
