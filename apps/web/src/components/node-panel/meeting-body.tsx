"use client";

/**
 * The body of a meeting in the panel — the compact counterpart of
 * `agents/meeting-node-view.tsx`, built from the same pieces:
 *
 *   · no transcript yet → `MeetingEmptyState` (paste one, or record with
 *     Recall) above the notes;
 *   · a bot in the call (`data.recording_status === "recording"`) → a
 *     one-line notice; the live timeline is the page's, "Open as page"
 *     is a click away;
 *   · a transcript → the Refined / Transcript selector (`MeetingViewSelector`,
 *     with refine status and retry), the transcript rendered read-only —
 *     it is derived from the recording and never edited — and the refined
 *     notes as the editable prose.
 *
 * The refine job's completion reaches the panel as a `node.updated`
 * broadcast: the inspector reloads, `data.refine_status` changes and the
 * selector updates itself. The selector's own `router.refresh()` is
 * harmless here.
 */

import { useState } from "react";
import { Radio } from "lucide-react";
import { MeetingEmptyState } from "@/components/agents/meeting-empty-state";
import { MeetingViewSelector } from "@/components/agents/meeting-view-selector";
import { NodeMarkdown } from "@/components/node-markdown";
import { resolveDefaultView, type MeetingView } from "@/lib/meetings/view";
import type { RefineStatus } from "@bcontext-dev/contract/meetings";
import { PanelProse } from "./prose-body";
import type { PanelBodyProps } from "./panel-body";

interface MeetingData {
  transcript_md?: string;
  refine_status?: RefineStatus;
  refine_error?: string | null;
  recording_status?: string | null;
  meeting_url?: string;
}

export function MeetingBody(props: PanelBodyProps) {
  const { payload, workspace, openNode } = props;
  const node = payload.node;
  const data = (node.data ?? {}) as MeetingData;
  const transcript = data.transcript_md ?? "";
  const hasTranscript = transcript.trim().length > 0;
  const [view, setView] = useState<MeetingView>(() => resolveDefaultView(data.refine_status, hasTranscript));

  if (data.recording_status === "recording") {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3 rounded-[12px] border border-[var(--line)] bg-[var(--paper-2)] p-3" role="status">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-[var(--accent)] text-[var(--accent)]">
            <Radio size={13} className="animate-pulse" />
          </span>
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-[var(--ink)]">Recording in progress</div>
            <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--ink-3)]">
              The bot is in the call. The transcript lands here when it ends; the live timeline is on the page.
            </p>
          </div>
        </div>
        <PanelProse {...props} />
      </div>
    );
  }

  if (!hasTranscript) {
    return (
      <div className="flex flex-col gap-2">
        <MeetingEmptyState workspace={workspace} nodeId={node.id} />
        <PanelProse {...props} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="-mt-3">
        <MeetingViewSelector
          view={view}
          status={data.refine_status}
          refineError={data.refine_error ?? null}
          nodeId={node.id}
          onChange={setView}
        />
      </div>
      {view === "transcript" ? (
        <NodeMarkdown markdown={transcript} onOpenNode={openNode} className="prose-meeting" />
      ) : (
        <PanelProse {...props} />
      )}
    </div>
  );
}
