import { apiJson, ApiError } from "@/web/api-client";
import type { AdminUserPage } from "@bcontext-dev/contract/admin-orgs";
import { Alert } from "@heroui/react";
import { AdminPage } from "@/components/admin/admin-shell";
import { UsersList } from "./users-list";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Admin · Users — Bcontext",
};

/** The API's own page size, so an answer that never arrived is still drawn
 *  with the shape of one. */
const PAGE_SIZE = 50;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function one(value: string | string[] | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Everyone with an account, and where they belong.
 *
 * Search, organization, role and state are query parameters and reach the
 * API, which applies them to every account it can see before cutting the
 * page. Narrowing them here would answer about the fifty rows that happened
 * to arrive — an address on page four would read as an address nobody has —
 * and reading them off the URL is also what makes the view survive a reload
 * and travel as a link.
 *
 * No standing prose above the table: the columns are named in the header row
 * and the count sits in the filter bar, so a screen opened every day costs
 * nothing to re-read.
 */
export default async function AdminUsersPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const { page, error } = await readUsers({
    q: one(sp.q),
    organization: one(sp.organization),
    role: one(sp.role),
    state: one(sp.state),
    offset: Math.max(0, Number.parseInt(one(sp.offset), 10) || 0),
  });

  return (
    <AdminPage>
      {error ? (
        <Alert role="alert" status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>Couldn&apos;t load users: {error}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : (
        <UsersList page={page} />
      )}
    </AdminPage>
  );
}

interface UsersQuery {
  q: string;
  organization: string;
  role: string;
  state: string;
  offset: number;
}

/**
 * The page the URL asked for. `limit` is left unsaid: the API's default is
 * the page size the panel wants, and repeating it here is a second place for
 * the two to stop agreeing.
 */
async function readUsers(
  query: UsersQuery,
): Promise<{ page: AdminUserPage; error: string | null }> {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.organization) params.set("organization", query.organization);
  if (query.role) params.set("role", query.role);
  if (query.state) params.set("state", query.state);
  if (query.offset > 0) params.set("offset", String(query.offset));
  const qs = params.toString();

  try {
    return {
      page: await apiJson<AdminUserPage>(
        qs ? `/api/admin/users?${qs}` : "/api/admin/users",
      ),
      error: null,
    };
  } catch (err) {
    return {
      page: {
        items: [],
        total: 0,
        limit: PAGE_SIZE,
        offset: query.offset,
        scanned: 0,
        cap: 0,
        capped: false,
      },
      error:
        err instanceof ApiError && err.status === 404
          ? "not available yet"
          : err instanceof ApiError
            ? err.message
            : "unavailable",
    };
  }
}
