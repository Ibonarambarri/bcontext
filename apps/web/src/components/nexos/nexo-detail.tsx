"use client";

/**
 * One Nexo's page, mounted by `app/w/[org]/[ws]/nexos/[nexo]/page.tsx`.
 *
 * Header (face, name, state, Run now — and Resume while paused) over four
 * tabs, kept in the URL (`?tab=`, plus `?section=` for Setup) so a link or
 * the guide can open any of them:
 *
 *   Chat      — the conversation. The general Nexo uses the shell's own
 *               session (the launcher's, so "Send to the panel" still
 *               works); a specialist mounts the same page inside a
 *               `NexoScopeProvider` pointed at `/api/nexos/:id/chat`.
 *   Inbox     — drafts to approve and escalations to settle.
 *   Activity  — its runs.
 *   Setup     — sources, what it can do, how it works, who it tells,
 *               instructions, budget, pause and delete (`nexo-setup-tab.tsx`).
 *
 * The retired `?tab=integrations|tools|settings` open Setup at the matching
 * section (`resolveNexoTab`), so old links and emails still land.
 *
 * `general` resolves through the list (the API creates the general Nexo on
 * the first list call), every other ref is an id. Edits are optimistic: the
 * header and the tabs read one copy of the Nexo, patched before the request
 * and restored if it fails.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";
import { ArrowLeft, Play, Zap } from "lucide-react";
import { Button, Chip, Skeleton, Tabs, Tooltip } from "@heroui/react";
import { cn, formatRelative } from "@bcontext-dev/contract/utils";
import { ViewHeaderSlot } from "@/components/view-header-slot";
import { useToast } from "@/components/workspace-context";
import type { UpdateNexoBody } from "@bcontext-dev/contract/nexos";
import { nexosApi, type NexoView } from "@/lib/nexos/api";
import { NEXO_TABS, nexosPath, type NexoTab } from "@/lib/view-shell";
import { resolveNexoTab } from "@/lib/nexos/tabs";
import type { WorkspaceAddress } from "@/web/workspace-url";
import { AUTONOMY_COPY, everyLabel } from "./nexo-copy";
import { NexoFace } from "./nexo-face";
import { NexoScopeProvider } from "./nexo-scope";

// The chat drags the markdown/streaming stack; the other tabs are only
// worth their weight once opened.
const NexoPage = dynamic(() => import("@/components/nexo/nexo-page").then((m) => m.NexoPage), {
  loading: () => <TabSkeleton />,
});
const NexoActivityTab = dynamic(() => import("./nexo-activity-tab").then((m) => m.NexoActivityTab), {
  loading: () => <TabSkeleton />,
});
const NexoInboxTab = dynamic(() => import("./nexo-inbox-tab").then((m) => m.NexoInboxTab), {
  loading: () => <TabSkeleton />,
});
const NexoSetupTab = dynamic(() => import("./nexo-setup-tab").then((m) => m.NexoSetupTab), {
  loading: () => <TabSkeleton />,
});

const TAB_LABELS: Record<NexoTab, string> = {
  chat: "Chat",
  inbox: "Inbox",
  activity: "Activity",
  setup: "Setup",
};

export function NexoDetail({ workspace, nexoRef }: { workspace: WorkspaceAddress; nexoRef: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const toast = useToast();
  const [nexo, setNexo] = useState<NexoView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const { tab, section } = resolveNexoTab(params.get("tab"), params.get("section"));

  const load = useCallback(async () => {
    try {
      let id = nexoRef;
      if (nexoRef === "general") {
        const list = await nexosApi.list(workspace);
        const general = list.find((n) => n.is_general);
        if (!general) throw new Error("This workspace has no general Nexo yet.");
        id = general.id;
      }
      setNexo(await nexosApi.get(workspace, id));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [nexoRef, workspace]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectTab = useCallback(
    (next: NexoTab) => {
      const query = new URLSearchParams(params.toString());
      if (next === "chat") query.delete("tab");
      else query.set("tab", next);
      for (const key of ["section", "connect", "item"]) query.delete(key);
      const suffix = query.toString();
      router.replace(`${pathname}${suffix ? `?${suffix}` : ""}` as Route, { scroll: false });
    },
    [params, pathname, router],
  );

  /** Optimistic PATCH: the page moves first, a refusal puts it back and says why. */
  const update = useCallback(
    async (patch: UpdateNexoBody, success?: string) => {
      if (!nexo) return false;
      const before = nexo;
      setNexo({ ...nexo, ...patch });
      try {
        const saved = await nexosApi.update(workspace, nexo.id, patch);
        setNexo((current) => (current ? { ...current, ...saved } : current));
        if (success) toast.info(success);
        return true;
      } catch (e) {
        setNexo(before);
        toast.error(`Couldn't save: ${(e as Error).message}`);
        return false;
      }
    },
    [nexo, toast, workspace],
  );

  const runNow = useCallback(async () => {
    if (!nexo) return;
    setRunning(true);
    try {
      await nexosApi.run(workspace, nexo.id);
      toast.info(`${nexo.name} is having a look.`);
    } catch (e) {
      toast.error(`Couldn't start a run: ${(e as Error).message}`);
    } finally {
      setRunning(false);
    }
  }, [nexo, toast, workspace]);

  // Stable, and a no-op when nothing changed: the tabs report back from effects.
  const setOpenCount = useCallback((count: number) => {
    setNexo((current) => (current && current.open_inbox_count !== count ? { ...current, open_inbox_count: count } : current));
  }, []);
  const setBindings = useCallback((bindings: NexoView["bindings"]) => {
    setNexo((current) => (current ? { ...current, bindings } : current));
  }, []);

  const nexoId = nexo?.id;
  const nexoName = nexo?.name;
  const persona = useMemo(
    () => (nexoId && nexoName ? { id: nexoId, name: nexoName } : null),
    [nexoId, nexoName],
  );

  if (error && !nexo) {
    return (
      <div className="mx-auto max-w-[560px] px-6 pt-16 text-center">
        <p className="text-[14px] font-medium text-foreground">This Nexo isn&apos;t available</p>
        <p className="mt-1 text-[12.5px] text-muted">{error}</p>
        <Link href={nexosPath(workspace)} className="mt-4 inline-flex items-center gap-1.5 text-[12.5px] text-foreground">
          <ArrowLeft size={13} /> Back to Nexos
        </Link>
      </div>
    );
  }

  if (!nexo) return <DetailSkeleton />;

  const paused = nexo.status === "paused";
  const subtitle = [
    nexo.description ||
      (nexo.is_general ? "Answers from the whole workspace and catches whatever no specialist owns." : "No description yet."),
    nexo.last_run_at ? `last active ${formatRelative(nexo.last_run_at)}` : null,
    !paused && nexo.heartbeat.enabled ? `checks ${everyLabel(nexo.heartbeat.every_minutes)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--paper)]">
      <ViewHeaderSlot>
        <span className="flex min-w-0 items-center gap-2 text-[13.5px]">
          <span aria-hidden="true" className="text-muted">/</span>
          <NexoFace name={nexo.name} general={nexo.is_general} size={18} />
          <span className="truncate font-medium text-foreground">{nexo.name}</span>
        </span>
      </ViewHeaderSlot>

      <header className="mx-auto flex w-full max-w-[1080px] flex-wrap items-center gap-x-4 gap-y-3 px-5 pt-5 sm:px-8 xl:px-12">
        <NexoFace name={nexo.name} general={nexo.is_general} size={56} animate="always" muted={paused} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="m-0 truncate text-[21px] font-semibold tracking-[-0.01em] text-foreground">{nexo.name}</h1>
            {nexo.is_general ? (
              <Chip size="sm" variant="soft">
                General
              </Chip>
            ) : null}
            <Chip size="sm" variant="soft" color={paused ? "default" : "accent"} className="gap-1.5">
              <span
                aria-hidden="true"
                className={cn("h-1.5 w-1.5 rounded-full", paused ? "bg-[var(--ink-mute)]" : "bg-[var(--accent)]")}
              />
              {paused ? "Paused" : AUTONOMY_COPY[nexo.autonomy].short}
            </Chip>
          </div>
          <p className="m-0 mt-1 line-clamp-1 text-[12.5px] text-muted" title={subtitle}>
            {subtitle}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {/* Pausing lives in Setup → Danger zone; coming back from it is one press here. */}
          {paused ? (
            <Button size="sm" variant="outline" className="gap-1.5" onPress={() => void update({ status: "active" }, `${nexo.name} is back at work.`)}>
              <Play size={13} />
              Resume
            </Button>
          ) : null}
          <Tooltip delay={400}>
            <Button size="sm" variant="outline" className="gap-1.5" onPress={() => void runNow()} isPending={running} isDisabled={paused}>
              <Zap size={13} />
              Run now
            </Button>
            <Tooltip.Content>Run its routine check once, right now</Tooltip.Content>
          </Tooltip>
        </div>
      </header>

      <Tabs
        className="mx-auto mt-4 w-full max-w-[1080px] px-5 sm:px-8 xl:px-12"
        selectedKey={tab}
        onSelectionChange={(key) => selectTab(key as NexoTab)}
      >
        <Tabs.ListContainer className="max-w-[520px]">
          <Tabs.List aria-label={`${nexo.name} sections`}>
            {NEXO_TABS.map((id) => (
              <Tabs.Tab key={id} id={id} className="whitespace-nowrap">
                {TAB_LABELS[id]}
                {id === "inbox" && nexo.open_inbox_count > 0 ? (
                  <span className="ml-1.5 rounded-full bg-[var(--accent)] px-1.5 text-[10.5px] font-medium leading-[16px] text-[var(--accent-ink,white)] tabular-nums">
                    {nexo.open_inbox_count}
                  </span>
                ) : null}
                <Tabs.Indicator />
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs.ListContainer>
      </Tabs>

      <div className="mt-1 min-h-0 flex-1 border-t border-[var(--line)]">
        {tab === "chat" ? (
          nexo.is_general ? (
            <NexoPage />
          ) : (
            <NexoScopeProvider nexo={persona!}>
              <NexoPage />
            </NexoScopeProvider>
          )
        ) : (
          <div className="scroll h-full overflow-y-auto">
            <div className="mx-auto max-w-[1080px] px-5 pb-20 pt-6 sm:px-8 xl:px-12">
              {tab === "activity" ? <NexoActivityTab workspace={workspace} nexo={nexo} /> : null}
              {tab === "inbox" ? (
                <NexoInboxTab
                  workspace={workspace}
                  nexo={nexo}
                  focusItemId={params.get("item")}
                  onOpenCountChange={setOpenCount}
                />
              ) : null}
              {tab === "setup" ? (
                <NexoSetupTab
                  workspace={workspace}
                  nexo={nexo}
                  section={section}
                  onUpdate={update}
                  onReplace={(next) => setNexo((current) => (current ? { ...current, ...next } : current))}
                  onBindingsChange={setBindings}
                  onDeleted={() => {
                    toast.info(`${nexo.name} was deleted.`);
                    router.push(nexosPath(workspace));
                  }}
                />
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TabSkeleton() {
  return (
    <div role="status" aria-label="Loading" className="mx-auto max-w-[1080px] px-5 pt-6 sm:px-8 xl:px-12">
      <Skeleton className="h-4 w-40 rounded" />
      <Skeleton className="mt-2 h-3 w-full max-w-md rounded" />
      <Skeleton className="mt-6 h-[76px] w-full rounded-[12px]" />
      <Skeleton className="mt-3 h-[76px] w-full rounded-[12px]" />
    </div>
  );
}

/** The header and the tab row in the shape they will have, so nothing jumps when the Nexo arrives. */
function DetailSkeleton() {
  return (
    <div role="status" aria-label="Loading the Nexo" className="mx-auto w-full max-w-[1080px] px-5 pt-5 sm:px-8 xl:px-12">
      <div className="flex items-center gap-4">
        <Skeleton className="h-14 w-14 rounded-full" />
        <div className="flex-1">
          <Skeleton className="h-5 w-48 rounded" />
          <Skeleton className="mt-2 h-3 w-72 rounded" />
        </div>
      </div>
      <div className="mt-6 flex gap-5">
        {Object.values(TAB_LABELS).map((label) => (
          <Skeleton key={label} className="h-4 w-16 rounded" />
        ))}
      </div>
    </div>
  );
}
