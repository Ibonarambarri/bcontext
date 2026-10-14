/**
 * GET /api/onboarding?workspace=… — the "Getting started" checklist the web
 * shows a person in a workspace, and POST /api/onboarding/dismiss.
 *
 * The steps are never stored. Each one is a fact the workspace already
 * holds (an agent has connected, an agent has written, …), so the checklist
 * cannot drift from reality: revoke the only agent and the step is pending
 * again. The one thing persisted is the dismissal, and it belongs to the
 * PERSON, not to the membership — someone who belongs to many workspaces
 * skips the guide once and never sees it again. The web may still open it
 * on demand; `dismissed_at` only decides whether it opens by itself.
 *
 * Copy (titles, hints, which element to spotlight) lives in the web: the
 * API states facts, the product explains them.
 */

/** In the order the guide presents them: connect, see it write, ask, feed. */
export const ONBOARDING_STEP_IDS = [
  "connect_agent",
  "first_agent_write",
  "ask_nexo",
  "connect_integration",
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

export interface OnboardingStep {
  id: OnboardingStepId;
  done: boolean;
}

export interface Onboarding {
  /** The workspace the steps were derived for, as `<org>/<workspace>`. */
  workspace: string;
  steps: OnboardingStep[];
  /** True when every step is done; the web treats it like a dismissal. */
  completed: boolean;
  /** When this person dismissed the guide, anywhere, or null. */
  dismissed_at: string | null;
}

/** POST /api/onboarding/dismiss answers with the timestamp it recorded. */
export interface OnboardingDismissal {
  dismissed_at: string;
}

/** The facts a workspace answers, one per step, from which the steps derive. */
export type OnboardingFacts = Record<OnboardingStepId, boolean>;

/** Turn the facts into the ordered step list the API returns. */
export function onboardingSteps(facts: OnboardingFacts): OnboardingStep[] {
  return ONBOARDING_STEP_IDS.map((id) => ({ id, done: facts[id] }));
}

export function onboardingCompleted(steps: readonly OnboardingStep[]): boolean {
  return steps.length > 0 && steps.every((s) => s.done);
}

/** The metadata key on the auth user; read and written only by the API. */
export const ONBOARDING_DISMISSED_KEY = "onboarding_dismissed_at";

/**
 * The dismissal timestamp out of a user's metadata, or null. Tolerates the
 * key being absent, null, or something that is not an ISO timestamp — the
 * metadata object is shared with other writers and we only trust our shape.
 */
export function onboardingDismissedAt(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const raw = metadata?.[ONBOARDING_DISMISSED_KEY];
  if (typeof raw !== "string" || Number.isNaN(Date.parse(raw))) return null;
  return raw;
}
