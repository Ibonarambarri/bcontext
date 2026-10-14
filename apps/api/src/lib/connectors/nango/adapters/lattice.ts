/**
 * Lattice — `lattice` → Nango `lattice` (API_KEY: Bearer; proxy base
 * https://api.latticehq.com/).
 *
 * Talent API v1 (https://developers.lattice.com): `GET /v1/goals` is
 * cursor-paged (`limit`, `startingAfter` ← `endingCursor`, `hasMore`) in
 * reverse creation order, with no "updated since" filter — so up to 5 pages
 * are read and kept when `updatedAt > since` (`config.states` narrows the
 * lifecycle states, default everything but Draft). `GET /v1/goals/updates`
 * (first page, newest first; the rows carry no timestamp) supplies the
 * latest progress comment + red/amber/green status per goal. Owners are
 * resolved to name + title through `GET /v1/users` (≤ 3 pages, no e-mail in
 * the text). `GET /v1/reviewCycles` changed since the cursor are signals too.
 * Timestamps arrive as epoch seconds (int32) or ISO strings; both handled.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, type NangoAdapter } from "./shared";

interface Ref {
  id?: string;
  name?: string | null;
  url?: string | null;
}

interface LatticeGoal {
  id: string;
  name?: string | null;
  description?: string | null;
  state?: string | null;
  goalType?: string | null;
  priority?: string | null;
  currentAmount?: number | null;
  endingAmount?: number | null;
  startingAmount?: number | null;
  dueDate?: string | null;
  owners?: Ref[] | null;
  parentGoal?: Ref | null;
  createdAt?: number | string | null;
  updatedAt?: number | string | null;
  url?: string | null;
}

interface LatticeGoalUpdate {
  id?: number | string;
  entityId?: string;
  goalId?: number | string;
  comment?: string | null;
  status?: string | null;
  increment?: number | string | null;
}

interface LatticeUser {
  id: string;
  name?: string | null;
  title?: string | null;
  status?: string | null;
}

interface LatticeReviewCycle {
  id: string;
  name?: string | null;
  stage?: string | null;
  createdAt?: number | string | null;
  updatedAt?: number | string | null;
  reviewsStartedAt?: number | string | null;
  reviewsEndedAt?: number | string | null;
  url?: string | null;
}

interface Page<T> {
  data?: T[];
  hasMore?: boolean;
  endingCursor?: string | null;
}

const PAGE = 100;
const GOAL_PAGES = 5;
const USER_PAGES = 3;
const DEFAULT_STATES = ["Active", "Ended", "Archived"];

/** Lattice mixes epoch seconds (int32) and ISO strings across resources. */
export function latticeDate(v: number | string | null | undefined): Date | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v);
  const n = Number(v);
  if (Number.isFinite(n) && /^\d+$/.test(v)) return new Date(n < 1e12 ? n * 1000 : n);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function iso(v: number | string | null | undefined): string | undefined {
  return latticeDate(v)?.toISOString();
}

async function readPages<T>(
  fetchPage: (startingAfter?: string) => Promise<Page<T> | undefined>,
  maxPages: number,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await fetchPage(cursor);
    out.push(...(page?.data ?? []));
    if (!page?.hasMore || !page.endingCursor) break;
    cursor = page.endingCursor;
  }
  return out;
}

export const latticeAdapter: NangoAdapter = {
  id: "lattice",
  provider: "lattice",
  sourceHint: "lattice:goals",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const states = allowList(config, "states") ?? DEFAULT_STATES;
    const goals = await readPages<LatticeGoal>(async (startingAfter) => {
      const res = await client.proxy<Page<LatticeGoal>>({
        method: "GET",
        providerConfigKey: "lattice",
        connectionId,
        path: "/v1/goals",
        query: { limit: PAGE, ...(startingAfter ? { startingAfter } : {}) },
      });
      if (!res.ok) throw new Error(`lattice goals failed (${res.status})`);
      return res.data;
    }, GOAL_PAGES);
    const changed = goals.filter((g) => {
      const at = latticeDate(g.updatedAt) ?? latticeDate(g.createdAt);
      return !!at && at > since && (!g.state || states.includes(g.state));
    });

    const latestUpdate = new Map<string, LatticeGoalUpdate>();
    if (changed.length) {
      const up = await client.proxy<Page<LatticeGoalUpdate>>({
        method: "GET",
        providerConfigKey: "lattice",
        connectionId,
        path: "/v1/goals/updates",
        query: { limit: PAGE },
      });
      for (const u of up.ok ? (up.data?.data ?? []) : []) {
        const key = String(u.goalId ?? "");
        if (key && !latestUpdate.has(key)) latestUpdate.set(key, u); // newest first
      }
    }

    const users = new Map<string, LatticeUser>();
    if (changed.length) {
      const rows = await readPages<LatticeUser>(async (startingAfter) => {
        const res = await client.proxy<Page<LatticeUser>>({
          method: "GET",
          providerConfigKey: "lattice",
          connectionId,
          path: "/v1/users",
          query: { limit: PAGE, ...(startingAfter ? { startingAfter } : {}) },
        });
        return res.ok ? res.data : undefined;
      }, USER_PAGES);
      for (const u of rows) users.set(u.id, u);
    }
    const owner = (r: Ref): string => {
      const u = r.id ? users.get(r.id) : undefined;
      return u ? `${u.name ?? r.id}${u.title ? ` (${u.title})` : ""}` : (r.name ?? r.id ?? "?");
    };

    const signals: IngestSignal[] = [];
    for (const g of changed.slice(0, limit)) {
      const upd = latestUpdate.get(String(g.id));
      const progress =
        typeof g.currentAmount === "number" && typeof g.endingAmount === "number"
          ? `${g.currentAmount} / ${g.endingAmount}`
          : typeof g.currentAmount === "number"
            ? String(g.currentAmount)
            : null;
      signals.push({
        external_id: `goal:${g.id}`,
        title: g.name?.trim() || `Goal ${g.id}`,
        text: [
          `Type: ${g.goalType ?? "?"} · State: ${g.state ?? "?"}${g.priority ? ` · Priority: ${g.priority}` : ""}`,
          progress ? `Progress: ${progress}` : null,
          g.dueDate ? `Due: ${g.dueDate}` : null,
          g.owners?.length ? `Owners: ${g.owners.map(owner).join(", ")}` : null,
          g.parentGoal ? `Parent goal: ${g.parentGoal.name ?? g.parentGoal.id}` : null,
          upd ? `Latest update${upd.status ? ` [${upd.status}]` : ""}: ${upd.comment ?? "(no comment)"}${upd.increment != null ? ` (+${upd.increment})` : ""}` : null,
          g.description ? `\n${clip(g.description)}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        url: g.url ?? undefined,
        author: g.owners?.[0] ? owner(g.owners[0]) : undefined,
        at: iso(g.updatedAt) ?? iso(g.createdAt),
        kind_hint: "goal",
      });
    }

    let cycles = 0;
    if (signals.length < limit) {
      const res = await client.proxy<Page<LatticeReviewCycle>>({
        method: "GET",
        providerConfigKey: "lattice",
        connectionId,
        path: "/v1/reviewCycles",
        query: { limit: 50 },
      });
      for (const c of res.ok ? (res.data?.data ?? []) : []) {
        const at = latticeDate(c.updatedAt) ?? latticeDate(c.createdAt);
        if (!at || at <= since) continue;
        cycles++;
        signals.push({
          external_id: `review-cycle:${c.id}`,
          title: `Review cycle · ${c.name ?? c.id}`,
          text: [
            `Stage: ${c.stage ?? "?"}`,
            c.reviewsStartedAt ? `Reviews started: ${iso(c.reviewsStartedAt)}` : null,
            c.reviewsEndedAt ? `Reviews ended: ${iso(c.reviewsEndedAt)}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
          url: c.url ?? undefined,
          at: at.toISOString(),
          kind_hint: "review_cycle",
        });
        if (signals.length >= limit) break;
      }
    }
    return { signals: signals.slice(0, limit), stats: { goals_scanned: goals.length, goals_changed: changed.length, review_cycles: cycles } };
  },
};
