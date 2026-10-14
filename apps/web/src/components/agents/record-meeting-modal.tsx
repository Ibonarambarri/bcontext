"use client";

/**
 * Record-meeting modal — opened by the ⌘⇧M shortcut, the Integrations hub
 * and the meeting empty state.
 *
 * Drops a Bcontext recorder into a Zoom/Meet/Teams/Webex call
 * (`POST /api/connectors/meeting-bot/schedule`). The user
 * pastes a URL, optionally sets a `joinAt`, ticks the recording-consent
 * checkbox, and submits. The modal then subscribes to
 * `meeting_bot.status` events on the workspace channel and updates an
 * inline timeline (`joining → in_call → call_ended → transcribing →
 * done`). When the meeting node is created, a "View meeting" CTA replaces
 * the spinner.
 *
 * Anti-goals:
 *   - No calendar discovery.
 *   - No streaming/real-time view of the transcript.
 *   - No multi-bot batching — one call per submission.
 */
import { useEffect, useMemo, useState } from "react";
import { Bot, Loader2, Mic, AlertCircle, ExternalLink, X } from "lucide-react";
import { Button, Modal } from "@heroui/react";
import { Stepper } from "@/components/ui/stepper";
import { useWorkspace } from "@/components/workspace-context";
import { useWorkspaceBroadcast } from "@/lib/collab/workspace-realtime";
import type { MeetingBotStatus } from "@bcontext-dev/contract/connectors/meeting-bot/provider";
import { workspaceApiRef, type WorkspaceAddress } from "@/web/workspace-url";

interface MeetingBotStatusEvent {
  botId: string;
  externalId: string;
  status: MeetingBotStatus;
  nodeId?: string;
  errorMessage?: string | null;
}

const TIMELINE: MeetingBotStatus[] = [
  "scheduled",
  "joining",
  "in_call",
  "call_ended",
  "transcribing",
  "done",
];

const LABELS: Record<MeetingBotStatus, string> = {
  scheduled: "Scheduled",
  joining: "Joining…",
  in_call: "Recording",
  call_ended: "Call ended",
  transcribing: "Transcribing…",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function RecordMeetingModal({
  open,
  onClose,
  workspace,
  attachToNodeId,
}: {
  open: boolean;
  onClose: () => void;
  workspace: WorkspaceAddress;
  /**
   * When set, the resulting transcript lands on this existing node
   * instead of materializing a new one. Used by the meeting-node empty
   * state CTA so the user can record into the node they just created.
   */
  attachToNodeId?: string;
}) {
  const { openNodePage } = useWorkspace();
  const [url, setUrl] = useState("");
  const [joinAt, setJoinAt] = useState("");
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [botId, setBotId] = useState<string | null>(null);
  const [status, setStatus] = useState<MeetingBotStatus | null>(null);
  const [nodeId, setNodeId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setUrl("");
      setJoinAt("");
      setConsent(false);
      setSubmitting(false);
      setError(null);
      setBotId(null);
      setStatus(null);
      setNodeId(null);
    }
  }, [open]);

  useWorkspaceBroadcast("meeting_bot.status", (event) => {
    const payload = event.payload as MeetingBotStatusEvent;
    if (!botId || payload.botId !== botId) return;
    setStatus(payload.status);
    if (payload.nodeId) setNodeId(payload.nodeId);
    if (payload.errorMessage) setError(payload.errorMessage);
  });

  const canSubmit = useMemo(() => {
    if (submitting || botId) return false;
    if (!consent) return false;
    try {
      const u = new URL(url);
      return ["http:", "https:"].includes(u.protocol);
    } catch {
      return false;
    }
  }, [url, consent, submitting, botId]);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/connectors/meeting-bot/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace: workspaceApiRef(workspace),
          meetingUrl: url,
          joinAt: joinAt ? new Date(joinAt).toISOString() : undefined,
          attachToNodeId,
          consent: true,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: unknown;
          message?: string;
        };
        // Prefer the human-readable `message` over the machine `error`
        // code so users see what the provider actually rejected (e.g. the
        // Recall 400 detail) instead of a generic string.
        const msg =
          typeof body.message === "string" && body.message.length > 0
            ? body.message
            : typeof body.error === "string"
              ? body.error
              : `Request failed (${res.status})`;
        setError(msg);
        return;
      }
      const body = (await res.json()) as {
        botId: string;
        status: MeetingBotStatus;
      };
      setBotId(body.botId);
      setStatus(body.status);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const reachedIdx = status ? TIMELINE.indexOf(status) : -1;
  const failed = status === "failed";

  return (
    <Modal.Backdrop
      isOpen={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      variant="blur"
    >
      <Modal.Container placement="top" className="p-5 pt-[80px]">
        <Modal.Dialog
          aria-label="Record a meeting"
          className="w-full max-w-[520px] rounded-[14px] border border-[var(--line)] bg-[var(--paper)] p-6 shadow-[0_24px_70px_rgba(0,0,0,0.18)]"
        >
          <Modal.CloseTrigger
            aria-label="Close"
            className="-mr-1 -mt-1 rounded-md p-1 text-[var(--ink-3)] hover:bg-[var(--paper-2)]"
          >
            <X size={14} />
          </Modal.CloseTrigger>

          <Modal.Header className="items-start gap-3 pb-5">
            <Modal.Icon className="border border-[var(--line)] bg-[var(--paper-2)]">
              <Mic size={16} />
            </Modal.Icon>
            <div className="flex-1">
              <Modal.Heading className="serif text-[19px] font-normal tracking-[-0.01em]">
                Record a meeting
              </Modal.Heading>
              <p className="text-[12.5px] text-[var(--ink-3)]">
                Drop a recorder into Zoom, Meet, Teams, or Webex. The transcript
                becomes a searchable node when the call ends.
              </p>
            </div>
          </Modal.Header>

          {!botId ? (
            <Modal.Body className="flex flex-col gap-5">
              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] text-[var(--ink-2)]">Meeting URL</span>
                <input
                  type="url"
                  placeholder="https://zoom.us/j/123…"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  className="h-9 rounded-md border border-[var(--line)] bg-[var(--paper-2)] px-3 text-[13.5px] outline-none focus:border-[var(--ink-3)]"
                />
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] text-[var(--ink-2)]">
                  Join at <span className="text-[var(--ink-mute)]">(optional)</span>
                </span>
                <input
                  type="datetime-local"
                  value={joinAt}
                  onChange={(e) => setJoinAt(e.target.value)}
                  className="h-9 rounded-md border border-[var(--line)] bg-[var(--paper-2)] px-3 text-[13.5px] outline-none focus:border-[var(--ink-3)]"
                />
                <span className="text-[11px] text-[var(--ink-mute)]">
                  Leave empty to join immediately.
                </span>
              </label>

              <label className="flex items-start gap-2.5 rounded-md border border-[var(--line)] bg-[var(--paper-2)] p-3">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                  className="mt-0.5"
                />
                <span className="text-[12px] leading-[1.55] text-[var(--ink-2)]">
                  I confirm participants will be informed of recording. The bot
                  announces itself on join; in two-party-consent regions, the
                  requester is responsible for verbal consent.
                </span>
              </label>

              {error && (
                <div className="flex items-start gap-2 rounded-md border border-[var(--accent-2)] bg-[var(--accent-2)] p-2.5 text-[12px] text-[var(--accent)]">
                  <AlertCircle size={13} className="mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 rounded-md px-3 text-[12.5px]"
                  onPress={onClose}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="h-8 gap-1.5 rounded-md bg-[var(--ink)] px-3 text-[12.5px] text-[var(--paper)]"
                  isDisabled={!canSubmit}
                  isPending={submitting}
                  onPress={() => void submit()}
                >
                  {({ isPending }) => (
                    <>
                      {isPending ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Bot size={12} />
                      )}
                      {joinAt ? "Schedule bot" : "Start recording"}
                    </>
                  )}
                </Button>
              </div>
            </Modal.Body>
          ) : (
            <Modal.Body className="flex flex-col gap-4">
              <div className="rounded-md border border-[var(--line)] bg-[var(--paper-2)] p-4">
                <div className="text-[11.5px] uppercase tracking-wide text-[var(--ink-3)]">
                  Bot status
                </div>
                <Stepper
                  className="mt-3"
                  orientation="vertical"
                  size="sm"
                  currentStep={reachedIdx}
                  style={
                    failed
                      ? ({
                          "--stepper-active-color": "#dc2626",
                          "--stepper-complete-color": "#dc2626",
                        } as React.CSSProperties)
                      : undefined
                  }
                >
                  {TIMELINE.map((s) => (
                    <Stepper.Step key={s}>
                      <Stepper.Indicator />
                      <Stepper.Content>
                        <Stepper.Title className="text-[12.5px]">{LABELS[s]}</Stepper.Title>
                      </Stepper.Content>
                      <Stepper.Separator />
                    </Stepper.Step>
                  ))}
                </Stepper>
              </div>

              {error && (
                <div className="flex items-start gap-2 rounded-md border border-[var(--accent-2)] bg-[var(--accent-2)] p-2.5 text-[12px] text-[var(--accent)]">
                  <AlertCircle size={13} className="mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              <div className="flex items-center justify-end gap-2">
                {nodeId ? (
                  <Button
                    size="sm"
                    className="h-8 gap-1.5 rounded-md bg-[var(--ink)] px-3 text-[12.5px] text-[var(--paper)]"
                    onPress={() => {
                      openNodePage(nodeId);
                      onClose();
                    }}
                  >
                    <ExternalLink size={12} />
                    Open meeting
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 rounded-md px-3 text-[12.5px]"
                    onPress={onClose}
                  >
                    Run in background
                  </Button>
                )}
              </div>
            </Modal.Body>
          )}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
