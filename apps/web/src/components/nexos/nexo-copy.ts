/**
 * The words the Nexos screens use for the API's enums, written once so the
 * card, the header, the wizard and the settings never describe the same
 * thing two ways. Pure; imported by every component in this folder.
 */
import {
  NEXO_CAN_DO_LABEL,
  NEXO_TONE_LABEL,
  type NexoAutonomy,
  type NexoCanDo,
  type NexoInboxKind,
  type NexoRunStatus,
  type NexoRunTrigger,
  type NexoTone,
} from "@bcontext-dev/contract/nexos";

/**
 * Autonomy, in plain language. `short` labels a chip; `what` is the one
 * sentence that tells someone who has never read the docs what they are
 * allowing.
 */
export const AUTONOMY_COPY: Record<NexoAutonomy, { label: string; short: string; what: string }> = {
  observe: {
    label: "Observe",
    short: "Observes",
    what: "Reads its sources and keeps the brain up to date. Never writes to anyone; when something needs a person, it tells you.",
  },
  draft: {
    label: "Draft",
    short: "Drafts replies",
    what: "Writes replies for you to approve. Nothing leaves until someone presses Approve in the inbox.",
  },
  act: {
    label: "Act",
    short: "Replies on its own",
    what: "Replies directly in the channels it listens to. Anything it is not sure about still comes to you.",
  },
};

export const AUTONOMY_ORDER: NexoAutonomy[] = ["observe", "draft", "act"];

export function canDoLabel(key: NexoCanDo): string {
  return NEXO_CAN_DO_LABEL[key].en;
}

export function toneLabel(key: NexoTone): string {
  return NEXO_TONE_LABEL[key].en;
}

export const TRIGGER_COPY: Record<NexoRunTrigger, string> = {
  chat: "Chat",
  heartbeat: "Routine check",
  event: "New message",
  batch: "Batch of messages",
  manual: "Run by hand",
};

export const RUN_STATUS_COPY: Record<NexoRunStatus, { label: string; color: "default" | "accent" | "success" | "danger" | "warning" }> = {
  running: { label: "Running", color: "accent" },
  succeeded: { label: "Done", color: "success" },
  failed: { label: "Failed", color: "danger" },
  skipped: { label: "Nothing to do", color: "default" },
};

export const INBOX_KIND_COPY: Record<NexoInboxKind, string> = {
  escalation: "Needs you",
  draft_reply: "Draft reply",
  approval: "Approval",
};

/** "every 30 min", "every 2 h", "daily". */
export function everyLabel(minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0) return minutes === 1440 ? "daily" : `every ${minutes / 1440} days`;
  if (minutes >= 60 && minutes % 60 === 0) return `every ${minutes / 60} h`;
  return `every ${minutes} min`;
}
