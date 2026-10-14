/**
 * What the "Getting started" guide says about each step and where it points.
 *
 * The API states the facts (`GET /api/onboarding` — which steps are done);
 * this module is the product's side of it: the title, what to do, what
 * makes the box tick, the view the step lives in and the `data-tour`
 * element on that view the spotlight rings — the actual button, not the
 * menu entry, so the tour ends with the cursor on the thing to press.
 * Pure and ordered by `ONBOARDING_STEP_IDS`, so the panel, the tour and
 * the tests read the same list. A step whose anchor is not in the DOM (the
 * page is still loading, the mobile sheet) still explains itself in a card.
 */
import {
  ONBOARDING_STEP_IDS,
  type OnboardingStep,
  type OnboardingStepId,
} from "@bcontext-dev/contract/onboarding";
import { nexoPath, nexosPath, systemViewPath } from "@/lib/view-shell";
import type { WorkspaceAddress } from "@/web/workspace-url";

export type GuideView = "overview" | "agents" | "nexos" | "nexo";

export interface GuideStep {
  id: OnboardingStepId;
  title: string;
  /** What to do, in one line — shown under the title while pending. */
  action: string;
  /** Why it matters, for the tour popover. */
  body: string;
  /** What makes the box tick by itself; the person never ticks it. */
  ticks: string;
  /**
   * The page the step happens in: `overview` (the dashboard), `agents` (the
   * Agents view, where Add agent lives), `nexos` (the team page, with Add
   * integration) or `nexo` (the general Nexo's chat).
   */
  view: GuideView;
  /** The `data-tour` value of the element the spotlight rings on that view. */
  anchor: string;
  /** Where the popover sits relative to the anchor. */
  placement: "top" | "bottom" | "left" | "right";
  /** Text the person can copy and paste into their agent, when one helps. */
  prompt?: string;
}

/**
 * What to ask an agent the first time. Concrete and small, so it works on
 * an empty workspace and produces something visible in the Brain.
 */
export const FIRST_WRITE_PROMPT =
  "In Bcontext, create a decision titled \"We keep decisions in Bcontext\" explaining that architecture and product decisions are recorded here so agents and people share one source of truth. Then create a task \"Connect the team's repos\" and link it to the decision.";

const COPY: Record<OnboardingStepId, Omit<GuideStep, "id">> = {
  connect_agent: {
    title: "Connect an agent",
    action: "Agents → Add agent, then paste the config into Claude Code, Codex or Cursor.",
    body:
      "Bcontext is written by your agents, not by hand. Add one here: you get an MCP config to paste into Claude Code, Codex or Cursor, and from then on it can read and write this workspace.",
    ticks: "Ticks itself once an agent is connected to this workspace.",
    view: "agents",
    anchor: "agents-add",
    placement: "bottom",
  },
  first_agent_write: {
    title: "Watch it write",
    action: "Ask your agent to record something — copy the prompt below.",
    body:
      "Give your agent something to write. It lands in the Brain as typed nodes, linked to each other, and this chart moves. Paste the prompt into the agent you just connected.",
    ticks: "Ticks itself the first time an agent creates or edits a node here.",
    view: "overview",
    anchor: "dashboard-activity",
    placement: "bottom",
    prompt: FIRST_WRITE_PROMPT,
  },
  ask_nexo: {
    title: "Ask Nexo",
    action: "Type a question; Nexo answers from this workspace, with sources.",
    body:
      "Nexo answers from what is in this workspace and cites where it found it. Try \"what did we decide about pricing?\" — or anything your agents have written down.",
    ticks: "Ticks itself the first time you send Nexo a message.",
    view: "nexo",
    anchor: "nexo-composer",
    placement: "top",
  },
  connect_integration: {
    title: "Feed it",
    action: "Nexos → open the general Nexo → connect a source: GitHub, Linear, Notion, Slack…",
    body:
      "Connect a source and a Nexo starts listening: the general one until you hand it to a specialist. The workspace fills itself, and anything that contradicts what is already here shows up in Conflicts for you to settle.",
    ticks: "Ticks itself once an integration is installed.",
    view: "nexos",
    anchor: "integrations-add",
    placement: "bottom",
  },
};

/** Where a step's page is. */
export function guideViewHref(address: WorkspaceAddress, view: GuideView): string {
  if (view === "nexo") return nexoPath(address);
  if (view === "nexos") return nexosPath(address);
  return systemViewPath(address, view);
}

/** The guide, in order. */
export const GUIDE_STEPS: GuideStep[] = ONBOARDING_STEP_IDS.map((id) => ({ id, ...COPY[id] }));

/** The guide step for an API step, by id. */
export function guideStep(id: OnboardingStepId): GuideStep {
  return GUIDE_STEPS[ONBOARDING_STEP_IDS.indexOf(id)]!;
}

/** The `data-tour` selector for a step's anchor. */
export function anchorSelector(step: GuideStep): string {
  return `[data-tour="${step.anchor}"]`;
}

/**
 * The step the tour should open on when nothing was chosen: the first one
 * still pending, or the first one when everything is done (a completed
 * guide is still worth a look back).
 */
export function firstPendingIndex(steps: readonly OnboardingStep[]): number {
  const pending = steps.findIndex((s) => !s.done);
  return pending === -1 ? 0 : pending;
}

/** "2 of 4" style progress for the panel header. */
export function doneCount(steps: readonly OnboardingStep[]): number {
  return steps.filter((s) => s.done).length;
}
