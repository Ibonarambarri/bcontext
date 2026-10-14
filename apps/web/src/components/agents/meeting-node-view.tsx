"use client";

/**
 * Meeting-node view — the body of `kind === "meeting"` nodes, loaded through
 * `lazy-node-body.tsx` by the node page.
 *
 * Wraps the standard Editor so a meeting node can switch between:
 *   - "Refined" view → live editor against node.content_md (collaborative,
 *     same as any other node).
 *   - "Transcript" view → read-only Markdown render of data.transcript_md.
 *
 * The transcript is derived from the recording — it's never editable. We
 * deliberately render it through `markdownToHtml` (no Yjs, no TipTap) so
 * collab traffic stays focused on the refined notes.
 *
 * Listens to the workspace realtime channel for `node.updated` events:
 * when the async refine job completes, content_md changes server-side; a
 * `router.refresh()` re-fetches the page snapshot. The selector swaps
 * "refining…" → "Refined" automatically.
 */
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Editor } from "@/components/editor";
import { markdownToHtml } from "@/lib/markdown";
import { useWorkspaceBroadcast } from "@/lib/collab/workspace-realtime";
import { MeetingEmptyState } from "./meeting-empty-state";
import { MeetingRecordingView } from "./meeting-recording-view";
import { MeetingViewSelector } from "./meeting-view-selector";
import { resolveDefaultView, type MeetingView } from "@/lib/meetings/view";
import type { RefineStatus } from "@bcontext-dev/contract/meetings";
import { type WorkspaceAddress } from "@/web/workspace-url";

export function MeetingNodeView({
  workspace,
  nodeId,
  nodeTitle,
  initialMarkdown,
  transcriptMd,
  refineStatus,
  refineError,
  recordingStatus,
  recordingMeetingUrl,
  initialView,
  header,
  footer,
}: {
  workspace: WorkspaceAddress;
  nodeId: string;
  nodeTitle?: string;
  initialMarkdown: string;
  transcriptMd: string;
  refineStatus: RefineStatus | undefined;
  refineError: string | null;
  /**
   * When set to `"recording"` the bot is in the call right now. The view
   * locks into MeetingRecordingView until the webhook clears the flag.
   */
  recordingStatus: string | null;
  recordingMeetingUrl: string | null;
  initialView: MeetingView;
  header: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const router = useRouter();
  const hasTranscript = transcriptMd.trim().length > 0;
  const [view, setView] = useState<MeetingView>(
    initialView ?? resolveDefaultView(refineStatus, hasTranscript),
  );

  // Refresh when the async refine job swaps content_md server-side so the
  // editor view picks up the structured text.
  useWorkspaceBroadcast("node.updated", (event) => {
    const payload = event.payload as { nodeId?: string };
    if (payload?.nodeId === nodeId) {
      router.refresh();
    }
  });

  const selectorNode = useMemo(
    () => (
      <MeetingViewSelector
        view={view}
        status={refineStatus}
        refineError={refineError}
        nodeId={nodeId}
        onChange={setView}
      />
    ),
    [view, refineStatus, refineError, nodeId],
  );

  const isRecording = recordingStatus === "recording";

  const composedHeader = (
    <>
      {header}
      {isRecording
        ? null
        : hasTranscript
          ? selectorNode
          : (
            <MeetingEmptyState workspace={workspace} nodeId={nodeId} />
          )}
    </>
  );

  if (isRecording) {
    return (
      <MeetingRecordingView
        nodeId={nodeId}
        meetingUrl={recordingMeetingUrl}
        initialStatus={null}
        header={composedHeader}
      />
    );
  }

  if (view === "transcript" && hasTranscript) {
    return (
      <TranscriptReader
        markdown={transcriptMd}
        header={composedHeader}
        footer={footer}
      />
    );
  }

  return (
    <Editor
      workspace={workspace}
      nodeId={nodeId}
      nodeTitle={nodeTitle}
      initialMarkdown={initialMarkdown}
      header={composedHeader}
      footer={footer}
    />
  );
}

function TranscriptReader({
  markdown,
  header,
  footer,
}: {
  markdown: string;
  header?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const [html, setHtml] = useState<string>("");
  useEffect(() => {
    setHtml(markdownToHtml(markdown));
  }, [markdown]);
  return (
    <div className="scroll h-full overflow-y-auto">
      <div className="mx-auto max-w-[760px] px-12 pb-20 pt-9">
        {header}
        <article
          className="prose-meeting"
          dangerouslySetInnerHTML={{ __html: html }}
        />
        {footer}
      </div>
    </div>
  );
}
