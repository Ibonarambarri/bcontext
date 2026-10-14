"use client";

/**
 * Locked "Recording in progress" view for a meeting node that has a bot
 * actively in the call (rendered by `meeting-node-view.tsx`).
 *
 * Renders instead of the editor while `data.recording_status === "recording"`.
 * Subscribes to `meeting_bot.status` broadcasts so the live timeline
 * (joining → in_call → call_ended → transcribing) updates in real-time.
 * When the webhook lands and clears `recording_status`, the page
 * `router.refresh()`es via the `node.updated` broadcast handled upstream
 * and this view unmounts.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Mic, Radio } from "lucide-react";
import { Stepper } from "@/components/ui/stepper";
import { useWorkspaceBroadcast } from "@/lib/collab/workspace-realtime";
import type { MeetingBotStatus } from "@bcontext-dev/contract/connectors/meeting-bot/provider";

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
  joining: "Bot is joining the call",
  in_call: "Recording in progress",
  call_ended: "Call ended",
  transcribing: "Transcribing audio",
  done: "Ready",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function MeetingRecordingView({
  nodeId,
  meetingUrl,
  initialStatus,
  header,
}: {
  nodeId: string;
  meetingUrl: string | null;
  initialStatus: MeetingBotStatus | null;
  header?: React.ReactNode;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<MeetingBotStatus>(initialStatus ?? "scheduled");

  // Realtime path — best-effort. When broadcasts work the UI updates
  // instantly per event.
  useWorkspaceBroadcast("meeting_bot.status", (event) => {
    const payload = event.payload as { botId?: string; status?: MeetingBotStatus; nodeId?: string };
    if (payload?.nodeId && payload.nodeId !== nodeId) return;
    if (payload?.status) setStatus(payload.status);
  });

  // Polling fallback — runs while the locked view is mounted. Catches
  // status transitions even when the Supabase Realtime broadcast times
  // out. Stops itself the moment the lock clears server-side; the
  // router.refresh() then unmounts this view in favour of the editor.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      try {
        const res = await fetch(`/api/meetings/${nodeId}/recording-status`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const body = (await res.json()) as {
          locked: boolean;
          status: MeetingBotStatus | null;
        };
        if (cancelled) return;
        if (body.status) setStatus(body.status);
        if (!body.locked) {
          // Webhook cleared the recording lock — re-render the page so
          // the editor view replaces this one.
          router.refresh();
          return;
        }
      } catch {
        // Network blip; the next tick retries.
      }
      if (!cancelled) {
        timer = setTimeout(tick, 2500);
      }
    }

    // First tick after a short delay so we don't race with the initial
    // server render's `node.updated` broadcast.
    timer = setTimeout(tick, 1500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [nodeId, router]);

  const reachedIdx = TIMELINE.indexOf(status);
  const failed = status === "failed" || status === "cancelled";

  return (
    <div className="scroll h-full overflow-y-auto">
      <div className="mx-auto max-w-[640px] px-12 pb-20 pt-9">
        {header}
        <div className="my-6 rounded-[14px] border border-[var(--line)] bg-[var(--paper-2)] p-6">
          <div className="flex items-center gap-3">
            <div
              className={
                "flex h-10 w-10 items-center justify-center rounded-full border " +
                (failed
                  ? "border-red-300 text-red-600"
                  : "border-[var(--accent)] text-[var(--accent)]")
              }
            >
              {failed ? <Mic size={16} /> : <Radio size={16} className="animate-pulse" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[14.5px] font-medium text-[var(--ink)]">
                {failed
                  ? "Recording stopped before a transcript was produced"
                  : "Recording — transcript will appear here when the call ends"}
              </div>
              <p className="mt-0.5 text-[12px] leading-[1.5] text-[var(--ink-3)]">
                The bot is in the call right now. This view unlocks
                automatically when the transcript lands. You can leave
                this page; the node updates server-side either way.
              </p>
            </div>
          </div>

          <Stepper
            className="mt-5"
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

          {meetingUrl && (
            <div className="mt-5 border-t border-[var(--line)] pt-3.5">
              <div className="mono text-[10.5px] uppercase tracking-widest text-[var(--ink-mute)]">
                Meeting URL
              </div>
              <a
                href={meetingUrl}
                target="_blank"
                rel="noreferrer"
                className="mono mt-1 inline-block break-all text-[11.5px] text-[var(--ink-2)] hover:text-[var(--ink)]"
              >
                {meetingUrl}
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
