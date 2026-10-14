/**
 * GET /api/admin/errors — a page of problems (not occurrences), most recently
 *     seen first, with the counts the filter bar is drawn from and the number
 *     of events recorded in the last 24h. `q` (over the headline message and
 *     the operation), `service`, `status` and `level` narrow the whole set
 *     before the page is cut, so a filter never answers about the page you
 *     happen to be on.
 *
 *     WITH NO `status`, THE ANSWER IS WHAT IS STILL OPEN — `new` and `ack`.
 *     This screen exists to answer "what is broken now", and a first page of
 *     three months of resolved problems does not answer it. `?status=resolved`
 *     is one click away and the status facet counts what is hidden, so it is
 *     a default rather than a wall. See `listAdminErrors`.
 *
 * A `service`, `status` or `level` nobody defined is a 400, exactly as an
 * unknown `state` is on the organizations list: answering a typo with the
 * unfiltered list would read as "no such problem exists".
 *
 * Platform admins only.
 */
import { gateAdmin } from "@/lib/admin/access";
import { readListParams } from "@/lib/admin/list-params";
import { listAdminErrors } from "@/lib/admin/errors";
import { withRoute } from "@/lib/route";
import {
  ERROR_LEVELS,
  ERROR_SERVICES,
  ERROR_STATUSES,
  type ErrorLevel,
  type ErrorService,
  type ErrorStatus,
} from "@bcontext-dev/contract/errors";

export const GET = withRoute(async (req: Request) => {
  const admin = await gateAdmin(req);
  if (admin instanceof Response) return admin;

  const url = new URL(req.url);
  const service = url.searchParams.get("service");
  if (service && !ERROR_SERVICES.includes(service as ErrorService)) {
    return Response.json({ error: "invalid_service" }, { status: 400 });
  }
  const status = url.searchParams.get("status");
  if (status && !ERROR_STATUSES.includes(status as ErrorStatus)) {
    return Response.json({ error: "invalid_status" }, { status: 400 });
  }
  const level = url.searchParams.get("level");
  if (level && !ERROR_LEVELS.includes(level as ErrorLevel)) {
    return Response.json({ error: "invalid_level" }, { status: 400 });
  }

  return Response.json(
    await listAdminErrors({
      ...readListParams(url),
      service: (service as ErrorService | null) ?? undefined,
      status: (status as ErrorStatus | null) ?? undefined,
      level: (level as ErrorLevel | null) ?? undefined,
    }),
  );
});
