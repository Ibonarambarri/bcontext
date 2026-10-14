"use client";

/**
 * The "Getting started" guide of a workspace: a small checklist card in the
 * corner of the active page, and a spotlight that takes the person to each
 * step's page and rings the button to press. Mounted by
 * `workspace-shell.tsx` for every workspace page; reopened from the
 * account menu (`bcontext:getting-started`).
 *
 * The checklist is not a to-do list the person ticks. Every step is a fact
 * the API derives from the workspace (`useOnboarding`), so the boxes tick
 * themselves as the agent connects, writes, is asked, is fed — and each
 * pending row says so in words, because a box that cannot be clicked has
 * to explain what will click it. What the person decides is only whether
 * to see the guide: collapsing it is for this page, skipping it is for
 * good and for every workspace they have (the dismissal is on the account,
 * see the API contract). A finished guide offers "Done", which is the same
 * skip with a better word.
 *
 * A row is a button: pressing it opens the step's view (if not already
 * there) and rings the real control on it — "Add agent", the Nexo
 * composer — so "how do I do this" is answered by the cursor, not by prose.
 *
 * Nothing here is remembered in the browser: a reload asks the API again,
 * which is the point of deriving instead of storing.
 */

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { Route } from "next";
import { Button, CloseButton } from "@heroui/react";
import { Check, ChevronLeft, ChevronRight, Copy, Sparkles } from "lucide-react";
import { cn } from "@bcontext-dev/contract/utils";
import { useToast, useWorkspace } from "@/components/workspace-context";
import { useOnboarding } from "@/hooks/use-onboarding";
import { Spotlight } from "./spotlight";
import { OPEN_GUIDE_EVENT } from "./events";
import { GUIDE_STEPS, anchorSelector, doneCount, firstPendingIndex, guideViewHref } from "./steps";

type Mode = "hidden" | "panel" | "pill";

export function GettingStarted() {
  const { address } = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  // Undecided until the API answers, so a dismissed guide never flashes.
  const [mode, setMode] = useState<Mode | null>(null);
  const [tour, setTour] = useState<number | null>(null);
  const { onboarding, loading, refresh, dismiss } = useOnboarding(address, mode === "panel" || mode === "pill");

  useEffect(() => {
    if (loading || mode !== null) return;
    setMode(onboarding && !onboarding.dismissed_at ? "panel" : "hidden");
  }, [loading, onboarding, mode]);

  useEffect(() => {
    const open = () => {
      setMode("panel");
      refresh();
    };
    window.addEventListener(OPEN_GUIDE_EVENT, open);
    return () => window.removeEventListener(OPEN_GUIDE_EVENT, open);
  }, [refresh]);

  // Opening a step means being on its page: the spotlight only rings what
  // is on screen. Same page, nothing to do; the anchor lookup waits for the
  // new page's elements otherwise. Compared by path, not by sidebar slug:
  // the Nexos page and the general Nexo's chat light the same entry.
  const openStep = useCallback(
    (index: number) => {
      const step = GUIDE_STEPS[index];
      if (!step) return;
      const href = guideViewHref(address, step.view);
      if (pathname !== href.split("?")[0]) router.push(href as Route);
      setTour(index);
    },
    [address, pathname, router],
  );

  const closeTour = useCallback(() => {
    setTour(null);
    refresh();
  }, [refresh]);

  const skip = useCallback(() => {
    setTour(null);
    setMode("hidden");
    void dismiss();
  }, [dismiss]);

  const copyPrompt = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast.info("Prompt copied — paste it into your agent.");
      } catch {
        toast.error("Could not copy. Select the text and copy it by hand.");
      }
    },
    [toast],
  );

  if (!onboarding || mode === null || mode === "hidden") return null;

  const steps = onboarding.steps;
  const done = doneCount(steps);
  const total = steps.length;

  if (tour !== null) {
    const step = GUIDE_STEPS[tour] ?? GUIDE_STEPS[0]!;
    const isDone = steps[tour]?.done ?? false;
    const last = tour === GUIDE_STEPS.length - 1;
    return (
      <Spotlight key={step.id} selector={anchorSelector(step)} placement={step.placement} onClose={closeTour}>
        <div className="flex items-start justify-between gap-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted">
            Step {tour + 1} of {GUIDE_STEPS.length}
            {isDone ? " · done" : ""}
          </p>
          <CloseButton aria-label="Close the tour" onPress={closeTour} className="-mr-1 -mt-1" />
        </div>
        <h3 className="mt-1 text-[14px] font-semibold text-foreground">{step.title}</h3>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">{step.body}</p>
        {step.prompt ? (
          <div className="mt-2.5 rounded-lg border border-[var(--line)] bg-[var(--paper-2)] p-2.5">
            <p className="line-clamp-3 text-[11.5px] leading-relaxed text-[var(--ink-2)]">{step.prompt}</p>
            <Button size="sm" variant="secondary" className="mt-2 h-7 gap-1.5 text-[12px]" onPress={() => copyPrompt(step.prompt!)}>
              <Copy size={12} /> Copy prompt
            </Button>
          </div>
        ) : null}
        <p className="mt-2.5 text-[11.5px] text-muted">{isDone ? "Done — this one ticked itself." : step.ticks}</p>
        <div className="mt-3 flex items-center gap-1.5">
          <Button size="sm" variant="ghost" onPress={closeTour}>
            Close
          </Button>
          <span className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            isIconOnly
            aria-label="Previous step"
            isDisabled={tour === 0}
            onPress={() => openStep(tour - 1)}
          >
            <ChevronLeft size={14} />
          </Button>
          {last ? (
            <Button size="sm" variant="primary" onPress={closeTour}>
              Finish
            </Button>
          ) : (
            <Button size="sm" variant="primary" className="gap-1" onPress={() => openStep(tour + 1)}>
              Next
              <ChevronRight size={14} />
            </Button>
          )}
        </div>
      </Spotlight>
    );
  }

  if (mode === "pill") {
    return (
      <button
        type="button"
        onClick={() => setMode("panel")}
        className="absolute bottom-4 left-4 z-30 flex items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--paper)] py-1.5 pl-2.5 pr-3 text-[12px] font-medium text-foreground shadow-md hover:bg-[var(--paper-2)]"
      >
        <Sparkles size={13} className="text-[var(--accent)]" />
        Getting started
        <span className="tabular-nums text-muted">
          {done}/{total}
        </span>
      </button>
    );
  }

  return (
    <section
      aria-label="Getting started"
      data-tour-panel=""
      className="absolute bottom-4 left-4 z-30 w-[340px] max-w-[calc(100%-32px)] rounded-xl border border-[var(--line)] bg-[var(--paper)] shadow-lg"
    >
      <header className="flex items-start gap-2 px-4 pt-3.5">
        <div className="min-w-0 flex-1">
          <h2 className="text-[13.5px] font-semibold text-foreground">
            {onboarding.completed ? "All set" : "Getting started"}
          </h2>
          <p className="mt-0.5 text-[12px] text-muted">
            {onboarding.completed
              ? "Your workspace is alive. Find this guide again under your account."
              : `${done} of ${total} · the boxes tick themselves as things happen.`}
          </p>
        </div>
        <CloseButton aria-label="Collapse the guide" onPress={() => setMode("pill")} className="-mr-1.5 -mt-1" />
      </header>
      <div className="mx-4 mt-3 h-1 overflow-hidden rounded-full bg-[var(--paper-3)]">
        <div
          className="h-full rounded-full bg-[var(--accent)] motion-safe:transition-[width]"
          style={{ width: `${(done / total) * 100}%` }}
        />
      </div>
      <ol className="mt-2 px-2 pb-1">
        {GUIDE_STEPS.map((step, index) => {
          const isDone = steps[index]?.done ?? false;
          return (
            <li key={step.id}>
              <button
                type="button"
                onClick={() => openStep(index)}
                aria-label={`${step.title}${isDone ? ", done" : ", pending"} — show me`}
                className="group flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-[var(--paper-2)] focus-visible:bg-[var(--paper-2)] focus-visible:outline-none"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "mt-px flex size-[18px] shrink-0 items-center justify-center rounded-full border",
                    isDone
                      ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-ink)]"
                      : "border-[var(--line-strong)] text-transparent",
                  )}
                >
                  <Check size={11} strokeWidth={3} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn("block text-[13px]", isDone ? "text-muted line-through" : "text-foreground")}>
                    {step.title}
                  </span>
                  {isDone ? null : (
                    <span className="mt-0.5 block text-[11.5px] leading-snug text-muted">{step.action}</span>
                  )}
                </span>
                <ChevronRight
                  size={14}
                  aria-hidden="true"
                  className="mt-0.5 shrink-0 text-muted opacity-40 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                />
              </button>
            </li>
          );
        })}
      </ol>
      <footer className="flex items-center justify-between gap-2 px-4 pb-3.5 pt-1">
        {onboarding.completed ? (
          <>
            <span />
            <Button size="sm" variant="primary" onPress={skip}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="ghost" className="text-muted" onPress={skip}>
              Skip for good
            </Button>
            <Button size="sm" variant="primary" onPress={() => openStep(firstPendingIndex(steps))}>
              Show me
            </Button>
          </>
        )}
      </footer>
    </section>
  );
}
