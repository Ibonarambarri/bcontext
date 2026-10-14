/**
 * Workday — `workday` → Nango `workday` (BASIC: integration-system user;
 * connection_config.hostname + tenant; Nango's proxy base is the SOAP root
 * https://{hostname}/ccx/service/{tenant}).
 *
 * The REST side lives on another root, so every call overrides the base to
 * https://{hostname}/ccx/api/v1/{tenant} and reads `GET /workers`
 * (`limit`/`offset`, ≤ 5 pages, envelope `{ data, total }`). Workday exposes
 * no "modified since" on workers and adapters keep no state, so this is a
 * snapshot, not a diff: one signal per supervisory organisation (headcount,
 * titles, managers, locations) stamped `at = since`. Re-proposing the same
 * `external_id` only refreshes a still-pending candidate, which keeps repeat
 * runs idempotent. `config.organizations` narrows the org names/ids. No
 * personal contact data leaves the adapter (names + titles only).
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, hostname, str, type NangoAdapter } from "./shared";

interface Descriptor {
  id?: string;
  descriptor?: string;
}

interface WorkdayWorker {
  id?: string;
  descriptor?: string;
  businessTitle?: string;
  isManager?: boolean;
  primaryJob?: {
    jobTitle?: string;
    businessTitle?: string;
    supervisoryOrganization?: Descriptor;
    location?: Descriptor;
    jobProfile?: Descriptor;
  };
  primarySupervisoryOrganization?: Descriptor;
  primaryWorkLocation?: Descriptor;
  hireDate?: string;
}

interface WorkersResponse {
  data?: WorkdayWorker[];
  total?: number;
}

const PAGE = 100;
const MAX_PAGES = 5;
const MAX_NAMES = 40;

export function workdayRestBase(connectionConfig: Record<string, unknown>): string | null {
  const host = hostname(connectionConfig);
  const tenant = str(connectionConfig.tenant);
  return host && tenant ? `https://${host}/ccx/api/v1/${tenant}` : null;
}

export const workdayAdapter: NangoAdapter = {
  id: "workday",
  provider: "workday",
  sourceHint: "workday:organizations",
  async fetchChanges({ client, connectionId, connectionConfig, config, since, limit }) {
    const base = workdayRestBase(connectionConfig);
    if (!base) return { signals: [], stats: { missing_connection_config: 1 } as Record<string, number> };
    const only = allowList(config, "organizations");

    const workers: WorkdayWorker[] = [];
    let offset = 0;
    let pages = 0;
    let total: number | undefined;
    for (;;) {
      const res = await client.proxy<WorkersResponse>({
        method: "GET",
        providerConfigKey: "workday",
        connectionId,
        path: "/workers",
        query: { limit: PAGE, offset },
        baseUrlOverride: base,
      });
      if (!res.ok) throw new Error(`workday workers failed (${res.status})`);
      pages++;
      const page = res.data?.data ?? [];
      workers.push(...page);
      total = res.data?.total ?? total;
      if (page.length < PAGE || pages >= MAX_PAGES) break;
      offset += PAGE;
    }

    const orgs = new Map<string, { name: string; workers: WorkdayWorker[] }>();
    for (const w of workers) {
      const org = w.primaryJob?.supervisoryOrganization ?? w.primarySupervisoryOrganization;
      const key = org?.id ?? org?.descriptor ?? "unassigned";
      const name = org?.descriptor ?? org?.id ?? "Unassigned";
      if (only && !only.includes(key) && !only.includes(name)) continue;
      const bucket = orgs.get(key) ?? { name, workers: [] };
      bucket.workers.push(w);
      orgs.set(key, bucket);
    }

    const signals: IngestSignal[] = [];
    for (const [key, org] of [...orgs.entries()].sort((a, b) => b[1].workers.length - a[1].workers.length)) {
      const titles = new Map<string, number>();
      const locations = new Map<string, number>();
      const managers: string[] = [];
      for (const w of org.workers) {
        const title = w.businessTitle ?? w.primaryJob?.businessTitle ?? w.primaryJob?.jobTitle ?? w.primaryJob?.jobProfile?.descriptor;
        if (title) titles.set(title, (titles.get(title) ?? 0) + 1);
        const loc = w.primaryJob?.location?.descriptor ?? w.primaryWorkLocation?.descriptor;
        if (loc) locations.set(loc, (locations.get(loc) ?? 0) + 1);
        if (w.isManager && w.descriptor) managers.push(w.descriptor);
      }
      const people = org.workers
        .slice(0, MAX_NAMES)
        .map((w) => `- ${w.descriptor ?? w.id ?? "?"}${w.businessTitle ?? w.primaryJob?.jobTitle ? ` — ${w.businessTitle ?? w.primaryJob?.jobTitle}` : ""}`)
        .join("\n");
      signals.push({
        external_id: `org:${key}`,
        title: `${org.name} · ${org.workers.length} ${org.workers.length === 1 ? "person" : "people"}`,
        text: [
          `Supervisory organisation: ${org.name}`,
          `Headcount: ${org.workers.length}${typeof total === "number" ? ` (of ${total} workers in the tenant)` : ""}`,
          managers.length ? `Managers: ${managers.join(", ")}` : null,
          titles.size ? `Titles: ${[...titles.entries()].map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join(", ")}` : null,
          locations.size ? `Locations: ${[...locations.entries()].map(([l, n]) => (n > 1 ? `${l} ×${n}` : l)).join(", ")}` : null,
          people ? `\nPeople:\n${people}${org.workers.length > MAX_NAMES ? `\n… and ${org.workers.length - MAX_NAMES} more` : ""}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        at: since.toISOString(),
        kind_hint: "org_snapshot",
      });
      if (signals.length >= limit) break;
    }
    return { signals, stats: { pages, workers: workers.length, organizations: orgs.size } };
  },
};
