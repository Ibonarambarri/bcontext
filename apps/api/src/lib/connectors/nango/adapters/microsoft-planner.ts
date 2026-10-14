/**
 * Microsoft Planner — `microsoft-planner` → Nango `microsoft-planner`
 * (alias of the `microsoft` OAuth2 provider; proxy base
 * https://graph.microsoft.com).
 *
 * Planner tasks carry `createdDateTime` and `completedDateTime` but no
 * "last modified" stamp and no server-side `$filter`, so every plan's
 * tasks are listed and kept when either instant is after the cursor —
 * new tasks and completions are what a company brain wants from Planner
 * anyway. Plans come from `/me/planner/plans` (or `config.plan_ids`),
 * buckets are resolved to names, and the first 30 kept tasks get their
 * `/details` (description + checklist).
 *
 * No deep link: Planner task URLs need the tenant domain, which Graph
 * does not return here.
 * Install config: `plan_ids`. Scope: Tasks.Read (+ Group.Read.All).
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import type { NangoClient } from "@/lib/nango/client";
import { graphIdentity, graphWalk } from "./graph";
import { allowList, clip, type NangoAdapter } from "./shared";

const KEY = "microsoft-planner";
const MAX_PLANS = 10;
const MAX_DETAILS = 30;

interface Plan {
  id: string;
  title?: string;
}
interface Bucket {
  id: string;
  name?: string;
}
export interface PlannerTask {
  id: string;
  title?: string;
  bucketId?: string;
  percentComplete?: number;
  priority?: number;
  dueDateTime?: string | null;
  createdDateTime?: string;
  completedDateTime?: string | null;
  createdBy?: unknown;
  completedBy?: unknown;
  assignments?: Record<string, unknown>;
}
interface TaskDetails {
  description?: string;
  checklist?: Record<string, { title?: string; isChecked?: boolean }>;
}

/** Planner priorities: 0-1 urgent, 2-4 important, 5-7 medium, 8-10 low. */
export function priorityLabel(p: number | undefined): string {
  if (p == null) return "unset";
  if (p <= 1) return "urgent";
  if (p <= 4) return "important";
  if (p <= 7) return "medium";
  return "low";
}

/** Keep a task when it was created or completed strictly after `since`. */
export function taskChangedSince(task: PlannerTask, since: Date): string | null {
  const done = task.completedDateTime ? Date.parse(task.completedDateTime) : NaN;
  if (!Number.isNaN(done) && done > since.getTime()) return task.completedDateTime as string;
  const created = task.createdDateTime ? Date.parse(task.createdDateTime) : NaN;
  if (!Number.isNaN(created) && created > since.getTime()) return task.createdDateTime as string;
  return null;
}

async function listPlans(client: NangoClient, connectionId: string, planIds: string[] | null): Promise<Plan[]> {
  if (planIds) {
    const plans: Plan[] = [];
    for (const id of planIds.slice(0, MAX_PLANS)) {
      const res = await client.proxy<Plan>({ method: "GET", providerConfigKey: KEY, connectionId, path: `/v1.0/planner/plans/${encodeURIComponent(id)}` });
      if (res.ok && res.data?.id) plans.push(res.data);
    }
    return plans;
  }
  const plans: Plan[] = [];
  await graphWalk<Plan>(client, KEY, connectionId, "/v1.0/me/planner/plans", {}, (p) => {
    plans.push(p);
    return plans.length < MAX_PLANS;
  }, { maxPages: 2 });
  return plans;
}

export const microsoftPlannerAdapter: NangoAdapter = {
  id: KEY,
  provider: "microsoft-planner",
  sourceHint: "microsoft-planner:tasks",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const plans = await listPlans(client, connectionId, allowList(config, "plan_ids"));
    const signals: IngestSignal[] = [];
    const stats: Record<string, number> = { plans: plans.length, tasks: 0, skipped: 0, details: 0 };
    let details = 0;
    for (const plan of plans) {
      const buckets = new Map<string, string>();
      const bucketRes = await client.proxy<{ value?: Bucket[] }>({ method: "GET", providerConfigKey: KEY, connectionId, path: `/v1.0/planner/plans/${encodeURIComponent(plan.id)}/buckets` });
      for (const b of bucketRes.ok ? (bucketRes.data?.value ?? []) : []) buckets.set(b.id, b.name ?? b.id);
      const kept: Array<{ task: PlannerTask; at: string }> = [];
      await graphWalk<PlannerTask>(client, KEY, connectionId, `/v1.0/planner/plans/${encodeURIComponent(plan.id)}/tasks`, {}, (task) => {
        const at = taskChangedSince(task, since);
        if (!at) {
          stats.skipped = (stats.skipped ?? 0) + 1;
          return true;
        }
        kept.push({ task, at });
        return signals.length + kept.length < limit;
      }, { maxPages: 4 });
      for (const { task, at } of kept) {
        let description = "";
        let checklist = "";
        if (details < MAX_DETAILS) {
          details += 1;
          const d = await client.proxy<TaskDetails>({ method: "GET", providerConfigKey: KEY, connectionId, path: `/v1.0/planner/tasks/${encodeURIComponent(task.id)}/details` });
          if (d.ok && d.data) {
            description = d.data.description ?? "";
            checklist = Object.values(d.data.checklist ?? {})
              .map((c) => `- [${c.isChecked ? "x" : " "}] ${c.title ?? ""}`)
              .join("\n");
          }
        }
        const author = graphIdentity(task.completedBy) ?? graphIdentity(task.createdBy);
        const assignees = Object.keys(task.assignments ?? {}).length;
        signals.push({
          external_id: `task:${task.id}`,
          title: `${plan.title ?? plan.id} · ${task.title ?? task.id}`,
          text: clip(
            [
              `Plan: ${plan.title ?? plan.id}${task.bucketId ? ` · Bucket: ${buckets.get(task.bucketId) ?? task.bucketId}` : ""}`,
              `Progress: ${task.percentComplete ?? 0}% · Priority: ${priorityLabel(task.priority)}${task.dueDateTime ? ` · Due: ${task.dueDateTime}` : ""}${assignees ? ` · Assignees: ${assignees}` : ""}`,
              `Created: ${task.createdDateTime ?? "?"}${task.completedDateTime ? ` · Completed: ${task.completedDateTime}` : ""}`,
              description ? `\n${description}` : "",
              checklist ? `\nChecklist:\n${checklist}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
            8000,
          ),
          author,
          at,
          kind_hint: "task",
        });
        stats.tasks = (stats.tasks ?? 0) + 1;
        if (signals.length >= limit) break;
      }
      if (signals.length >= limit) break;
    }
    stats.details = details;
    return { signals: signals.slice(0, limit), stats };
  },
};
