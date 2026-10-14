"use client";

/**
 * A Nexo's Activity tab: what it did, run by run — why it woke up (a chat, its
 * routine, a message on one of its channels, a batch), how it ended, what it
 * said and which tools it used. Read from `GET /api/nexos/:id/runs`, newest
 * first, re-read every 15 s while a run is still going.
 *
 * Also the place to give it a one-off job: "Run with an instruction" posts
 * `POST /api/nexos/:id/run` and the new run shows up at the top.
 */
import { useCallback, useEffect, useState } from "react";
import { Wrench } from "lucide-react";
import { Button, Chip, Disclosure } from "@heroui/react";
import { EmptyState } from "@/components/ui/empty-state";
import { cn, formatRelative } from "@bcontext-dev/contract/utils";
import { ListSkeleton } from "@/components/skeletons";
import { useToast } from "@/components/workspace-context";
import type { NexoRun } from "@bcontext-dev/contract/nexos";
import { nexosApi, type NexoView } from "@/lib/nexos/api";
import type { WorkspaceAddress } from "@/web/workspace-url";
import { RUN_STATUS_COPY, TRIGGER_COPY } from "./nexo-copy";
import { NexoFace } from "./nexo-face";
import { NexoRichText } from "./nexo-rich-text";
import { TextQuestion } from "./nexo-fields";

const LIVE_POLL_MS = 15_000;

export function NexoActivityTab({ workspace, nexo }: { workspace: WorkspaceAddress; nexo: NexoView }) {
  const toast = useToast();
  const [runs, setRuns] = useState<NexoRun[] | null>(nexo.recent_runs?.length ? nexo.recent_runs : null);
  const [error, setError] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    try {
      setRuns(await nexosApi.runs(workspace, nexo.id));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [nexo.id, workspace]);

  useEffect(() => {
    void load();
  }, [load]);

  const live = runs?.some((run) => run.status === "running") ?? false;
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => void load(), LIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [live, load]);

  const start = async () => {
    const text = instruction.trim();
    if (!text) return;
    setStarting(true);
    try {
      await nexosApi.run(workspace, nexo.id, text);
      setInstruction("");
      toast.info(`${nexo.name} is on it.`);
      // The run row exists by the time the API answers; read it in.
      void load();
    } catch (e) {
      toast.error(`Couldn't start the run: ${(e as Error).message}`);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Give it a job" className="rounded-[14px] border border-[var(--line)] bg-[var(--paper-2)] p-4">
        <TextQuestion
          label="Give it a job"
          hint={`${nexo.name} runs once with this instruction, with the same tools and limits as always.`}
          value={instruction}
          onChange={setInstruction}
          placeholder="Summarise this week's open threads and flag anything stuck."
          rows={2}
          isDisabled={nexo.status === "paused"}
        />
        <div className="mt-3 flex justify-end">
          <Button size="sm" onPress={() => void start()} isPending={starting} isDisabled={!instruction.trim() || nexo.status === "paused"}>
            Run
          </Button>
        </div>
      </section>

      <section aria-labelledby="nexo-runs">
        <h2 id="nexo-runs" className="m-0 text-[15px] font-medium">
          Runs
        </h2>
        <p className="mt-0.5 text-[12px] text-[var(--ink-3)]">Every time it woke up, newest first.</p>
        {error && !runs ? (
          <p role="alert" className="mt-4 text-[12.5px] text-danger">
            {error}
          </p>
        ) : !runs ? (
          <ListSkeleton rows={4} />
        ) : runs.length === 0 ? (
          <EmptyState className="mt-4 min-h-[220px] rounded-[14px] border border-dashed border-[var(--line)] bg-[var(--paper-2)]">
            <EmptyState.Header>
              <EmptyState.Media>
                <NexoFace name={nexo.name} general={nexo.is_general} size={44} animate="always" />
              </EmptyState.Media>
              <EmptyState.Title>Nothing yet</EmptyState.Title>
              <EmptyState.Description className="max-w-[380px]">
                Runs appear here when it checks its routine, reads a new message on its channels, or you talk to it.
              </EmptyState.Description>
            </EmptyState.Header>
          </EmptyState>
        ) : (
          <ol className="mt-4 flex list-none flex-col gap-2 p-0">
            {runs.map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function RunRow({ run }: { run: NexoRun }) {
  const status = RUN_STATUS_COPY[run.status];
  const steps = run.steps ?? [];
  const hasDetail = Boolean(run.output_md || run.error || steps.length);
  const duration =
    run.finished_at && run.started_at
      ? Math.max(0, Math.round((Date.parse(run.finished_at) - Date.parse(run.started_at)) / 1000))
      : null;
  const head = (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <Chip size="sm" variant="soft" color={status.color} className="shrink-0">
        {status.label}
      </Chip>
      <span className="truncate text-[13px] text-foreground">{TRIGGER_COPY[run.trigger] ?? run.trigger}</span>
      <span className="ml-auto flex shrink-0 items-center gap-3 text-[11.5px] tabular-nums text-muted">
        {steps.length ? (
          <span className="flex items-center gap-1">
            <Wrench size={11} />
            {steps.length}
          </span>
        ) : null}
        {typeof run.usage?.credits === "number" ? <span>{run.usage.credits} cr</span> : null}
        {duration != null ? <span>{duration < 60 ? `${duration}s` : `${Math.round(duration / 60)}m`}</span> : null}
        <span>{formatRelative(run.started_at)}</span>
      </span>
    </div>
  );

  if (!hasDetail) {
    return <li className="flex items-center rounded-[12px] border border-[var(--line)] px-4 py-3">{head}</li>;
  }

  return (
    <li className="rounded-[12px] border border-[var(--line)]">
      <Disclosure>
        <Disclosure.Heading>
          <Button slot="trigger" variant="ghost" fullWidth className="h-auto justify-start gap-2 rounded-[12px] px-4 py-3 text-left">
            {head}
            <Disclosure.Indicator />
          </Button>
        </Disclosure.Heading>
        <Disclosure.Content>
          <Disclosure.Body className="px-4 pb-4">
            {run.error ? <p className="m-0 text-[12.5px] text-danger">{run.error}</p> : null}
            {run.output_md ? <NexoRichText markdown={run.output_md} className={cn(run.error && "mt-2")} /> : null}
            {steps.length ? (
              <ul className="m-0 mt-3 flex list-none flex-col gap-1 p-0">
                {steps.map((step, index) => (
                  <li key={index} className="flex items-center gap-2 text-[11.5px] text-muted">
                    <span
                      aria-hidden="true"
                      className={cn("h-1.5 w-1.5 rounded-full", step.ok === false ? "bg-danger" : "bg-[var(--ink-mute)]")}
                    />
                    <span className="mono">{step.tool}</span>
                    {step.note ? <span className="truncate">{step.note}</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </Disclosure.Body>
        </Disclosure.Content>
      </Disclosure>
    </li>
  );
}
