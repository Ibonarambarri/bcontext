import { apiJson, ApiError } from "@/web/api-client";
import type { AdminErrorPage } from "@bcontext-dev/contract/errors";
import { Alert } from "@heroui/react";
import { AdminPage } from "@/components/admin/admin-shell";
import { ErrorsList } from "./errors-list";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Admin · Errors — Bcontext",
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
 * What is broken, one problem per row.
 *
 * Events are folded into groups by the collector, never here: four thousand
 * occurrences are twelve problems, and a screen that listed occurrences would
 * be unreadable by its second day. So this reads groups, and the detail page
 * is where the occurrences live.
 *
 * Search, service, status and level are query parameters and reach the API,
 * which applies them to every group it holds before it cuts the page.
 * Narrowing them here would answer about the fifty rows that happened to
 * arrive — a problem on page four would read as a problem nobody has — and
 * reading them off the URL is also what makes the view survive a reload and
 * travel as a link to whoever is being asked to look at it.
 *
 * No standing prose above the table: the columns are named in the header row
 * and the day's volume sits in the filter bar, so a screen opened during an
 * incident costs nothing to re-read.
 */
export default async function AdminErrorsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const { page, error } = await readErrors({
    q: one(sp.q),
    service: one(sp.service),
    status: one(sp.status),
    level: one(sp.level),
    offset: Math.max(0, Number.parseInt(one(sp.offset), 10) || 0),
  });

  return (
    <AdminPage>
      {error ? (
        <Alert role="alert" status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>Couldn&apos;t load errors: {error}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : (
        <ErrorsList page={page} />
      )}
    </AdminPage>
  );
}

interface ErrorsQuery {
  q: string;
  service: string;
  status: string;
  level: string;
  offset: number;
}

/**
 * The page the URL asked for. `limit` is left unsaid: the API's default is
 * the page size the panel wants, and repeating it here is a second place for
 * the two to stop agreeing. So is the default status — a bare call already
 * means "everything still open", and spelling it out here would silently
 * disagree with the API the day that default moves.
 */
async function readErrors(
  query: ErrorsQuery,
): Promise<{ page: AdminErrorPage; error: string | null }> {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.service) params.set("service", query.service);
  if (query.status) params.set("status", query.status);
  if (query.level) params.set("level", query.level);
  if (query.offset > 0) params.set("offset", String(query.offset));
  const qs = params.toString();

  try {
    return {
      page: await apiJson<AdminErrorPage>(
        qs ? `/api/admin/errors?${qs}` : "/api/admin/errors",
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
        facets: { services: [], statuses: [] },
        events24h: 0,
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
