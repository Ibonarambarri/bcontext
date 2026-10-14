"use client";

/**
 * Setup → What it can do: what a Nexo may touch.
 *
 *   · the brain — reading (search, open nodes) and writing (create and edit
 *     nodes) as two switches, stored on the Nexo as `brain_tools` (a PATCH) and
 *     mapped by the API onto its agent's grants;
 *   · tool providers — the workspace's approved capabilities (MCP servers,
 *     APIs, workflows from `GET /api/capabilities`), each granted or not to
 *     this Nexo. `PUT /api/nexos/:id/tools` takes the whole desired set, so a
 *     toggle sends every grant it keeps — bundles included — and the answer
 *     replaces the local copy. Granting needs a workspace admin; the API says
 *     so when it refuses. Providers themselves are added in the Tools view.
 *
 * Every switch is optimistic and puts itself back if the API refuses.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BookOpen, PenLine } from "lucide-react";
import type { NexoTools, UpdateNexoBody } from "@bcontext-dev/contract/nexos";
import { ListSkeleton } from "@/components/skeletons";
import { useToast, useWorkspace } from "@/components/workspace-context";
import { nexosApi, type NexoView } from "@/lib/nexos/api";
import { systemViewPath } from "@/lib/view-shell";
import type { WorkspaceAddress } from "@/web/workspace-url";
import { SettingSwitch } from "./nexo-fields";

interface CatalogEntry {
  id: string;
  title: string;
  description: string;
  status: string;
}

export function NexoAbilities({
  workspace,
  nexo,
  onUpdate,
}: {
  workspace: WorkspaceAddress;
  nexo: NexoView;
  onUpdate: (patch: UpdateNexoBody) => Promise<boolean>;
}) {
  const toast = useToast();
  const { workspace: current } = useWorkspace();
  const workspaceId = current?.id ?? null;
  const [tools, setTools] = useState<NexoTools>(nexo.tools);
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    nexosApi
      .tools(workspace, nexo.id)
      .then((fresh) => {
        if (!cancelled) setTools(fresh);
      })
      .catch(() => {
        // The detail's copy is already on screen.
      });
    if (!workspaceId) {
      setCatalog([]);
      return;
    }
    fetch(`/api/capabilities?workspace_id=${encodeURIComponent(workspaceId)}&status=approved`, { cache: "no-store" })
      .then(async (r) => {
        const body = (await r.json().catch(() => ({}))) as { capabilities?: CatalogEntry[]; message?: string };
        if (!r.ok) throw new Error(body.message ?? `HTTP ${r.status}`);
        if (!cancelled) setCatalog(body.capabilities ?? []);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [nexo.id, workspace, workspaceId]);

  const granted = useMemo(
    () => new Set(tools.grants.map((g) => g.capability_id).filter((id): id is string => Boolean(id))),
    [tools.grants],
  );
  const bundles = useMemo(() => tools.grants.filter((g) => g.bundle_id), [tools.grants]);

  const save = async (capabilityIds: string[], bundleIds: string[]) => {
    const before = tools;
    // Optimistic: the switch flips now; the API's answer is the truth after.
    setTools({
      ...tools,
      grants: [
        ...capabilityIds.map((id) => tools.grants.find((g) => g.capability_id === id) ?? {
          id: `pending-${id}`,
          capability_id: id,
          bundle_id: null,
          title: null,
          actions: [],
          expires_at: null,
          created_at: new Date().toISOString(),
        }),
        ...tools.grants.filter((g) => g.bundle_id && bundleIds.includes(g.bundle_id)),
      ],
    });
    try {
      setTools(await nexosApi.setTools(workspace, nexo.id, { capability_ids: capabilityIds, bundle_ids: bundleIds }));
    } catch (e) {
      setTools(before);
      toast.error(`Couldn't change its tools: ${(e as Error).message}`);
    }
  };

  const bundleIds = bundles.map((g) => g.bundle_id!);
  const toggleCapability = (id: string, on: boolean) =>
    void save(on ? [...granted, id] : [...granted].filter((c) => c !== id), bundleIds);
  const dropBundle = (id: string) => void save([...granted], bundleIds.filter((b) => b !== id));

  const brain = nexo.brain_tools ?? { read: true, write: false };

  return (
    <div className="flex flex-col gap-6">
      <ul aria-label="The brain" className="m-0 flex list-none flex-col divide-y divide-[var(--line)] rounded-[14px] border border-[var(--line)] p-0">
        <ToggleRow
          icon={<BookOpen size={15} />}
          title="Read the brain"
          body="Search it and open nodes to answer and to decide."
          isSelected={brain.read}
          onChange={(on) => void onUpdate({ brain_tools: { read: on, write: on ? brain.write : false } })}
        />
        <ToggleRow
          icon={<PenLine size={15} />}
          title="Write to the brain"
          body="Create and edit decisions, tasks and docs. Every change shows in Activity with its name on it."
          isSelected={brain.write}
          isDisabled={!brain.read}
          onChange={(on) => void onUpdate({ brain_tools: { ...brain, write: on } })}
        />
      </ul>

      <div>
        <p className="m-0 text-[13px] font-medium text-foreground">Tools</p>
        <p className="m-0 mt-0.5 text-[12px] text-muted">
          External tools it may call, from this workspace&apos;s approved providers (added in{" "}
          <Link href={systemViewPath(workspace, "tools")} className="text-foreground underline underline-offset-2">
            Tools
          </Link>
          ).
        </p>
        {error && !catalog ? (
          <p role="alert" className="mt-3 text-[12.5px] text-danger">
            {error}
          </p>
        ) : !catalog ? (
          <ListSkeleton rows={2} />
        ) : catalog.length === 0 && bundles.length === 0 ? (
          <p className="m-0 mt-3 text-[12.5px] text-[var(--ink-3)]">No approved tool providers yet.</p>
        ) : (
          <ul className="m-0 mt-3 flex list-none flex-col divide-y divide-[var(--line)] rounded-[14px] border border-[var(--line)] p-0">
            {catalog.map((entry) => (
              <ToggleRow
                key={entry.id}
                title={entry.title}
                body={entry.description || undefined}
                isSelected={granted.has(entry.id)}
                onChange={(on) => toggleCapability(entry.id, on)}
              />
            ))}
            {bundles.map((grant) => (
              <ToggleRow
                key={grant.id}
                title={grant.title ?? "Tool bundle"}
                body="A bundle of tools granted to it."
                isSelected
                onChange={(on) => (!on ? dropBundle(grant.bundle_id!) : undefined)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ToggleRow({
  icon,
  title,
  body,
  isSelected,
  isDisabled,
  onChange,
}: {
  icon?: React.ReactNode;
  title: string;
  body?: string;
  isSelected: boolean;
  isDisabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <li className="px-4 py-3.5">
      <SettingSwitch icon={icon} title={title} description={body} isSelected={isSelected} isDisabled={isDisabled} onChange={onChange} />
    </li>
  );
}
