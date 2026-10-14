"use client";

/**
 * Banner shown on `meeting` nodes that don't have a transcript attached
 * yet (rendered by `meeting-node-view.tsx` inside the node header, above the
 * editor) with two CTAs:
 *
 *   1. **Paste transcript** — opens an inline textarea. POST to
 *      /api/meetings/attach-transcript/[nodeId] → kicks off refine.
 *   2. **Record with Recall** — opens the existing RecordMeetingModal
 *      pre-bound to this node via `attachToNodeId`. When the bot
 *      finishes, the webhook updates THIS node instead of creating a
 *      new one.
 *
 * Disappears as soon as `data.transcript_md` is populated server-side
 * (page refreshes on `node.updated` broadcast).
 */
import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { ClipboardPaste, Loader2, Mic, X } from "lucide-react";
import { Button } from "@heroui/react";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/components/workspace-context";
import { RecordMeetingModal } from "./record-meeting-modal";
import { type WorkspaceAddress } from "@/web/workspace-url";

export function MeetingEmptyState({
  workspace,
  nodeId,
}: {
  workspace: WorkspaceAddress;
  nodeId: string;
}) {
  const [mode, setMode] = useState<"idle" | "paste" | "record">("idle");

  return (
    <div className="my-4 rounded-[12px] border border-dashed border-[var(--line)] bg-[var(--paper-2)] p-4">
      {mode === "idle" && <IdleBanner onPaste={() => setMode("paste")} onRecord={() => setMode("record")} />}
      {mode === "paste" && (
        <PastePanel
          nodeId={nodeId}
          onClose={() => setMode("idle")}
        />
      )}
      {mode === "record" && (
        <RecordMeetingModal
          open
          onClose={() => setMode("idle")}
          workspace={workspace}
          attachToNodeId={nodeId}
        />
      )}
    </div>
  );
}

function IdleBanner({
  onPaste,
  onRecord,
}: {
  onPaste: () => void;
  onRecord: () => void;
}) {
  return (
    <EmptyState size="sm" className="items-start gap-3 py-0 text-left">
      <EmptyState.Header className="items-start gap-1">
        <EmptyState.Title className="text-[13px] font-medium text-[var(--ink)]">
          Add a transcript to start
        </EmptyState.Title>
        <EmptyState.Description className="mt-0.5 text-[12px] leading-[1.5] text-[var(--ink-3)]">
          A meeting node becomes searchable once it has a transcript. Paste
          one you already have, or drop a Recall.ai bot into a live call.
        </EmptyState.Description>
      </EmptyState.Header>
      <EmptyState.Content className="flex-row flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 rounded-md px-3 text-[12.5px]"
          onPress={onPaste}
        >
          <ClipboardPaste size={12} />
          Paste transcript
        </Button>
        <Button
          size="sm"
          className="h-8 gap-1.5 rounded-md bg-[var(--ink)] px-3 text-[12.5px] text-[var(--paper)]"
          onPress={onRecord}
        >
          <Mic size={12} />
          Record with Recall
        </Button>
      </EmptyState.Content>
    </EmptyState>
  );
}

function PastePanel({
  nodeId,
  onClose,
}: {
  nodeId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const trimmed = value.trim();
  const canSubmit = trimmed.length >= 50 && !submitting;

  const submit = useCallback(async () => {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/meetings/attach-transcript/${nodeId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: trimmed }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: unknown;
          message?: string;
        };
        const msg =
          typeof body.error === "string"
            ? body.error
            : body.message ?? `Request failed (${res.status})`;
        toast.error(msg);
        return;
      }
      toast.info("Transcript attached — refining…");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [nodeId, trimmed, router, toast]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[13px] font-medium text-[var(--ink)]">
            Paste transcript
          </div>
          <p className="mt-0.5 text-[12px] leading-[1.5] text-[var(--ink-3)]">
            Plain text or Markdown. Speaker labels keep their format (e.g.
            <span className="mono">{" **Alice · 00:14** — "}</span>). Minimum 50
            characters.
          </p>
        </div>
        <Button
          isIconOnly
          variant="ghost"
          size="sm"
          className="-mr-1 -mt-1 h-auto min-w-0 rounded-md p-1 text-[var(--ink-3)] hover:bg-[var(--paper)]"
          aria-label="Cancel"
          onPress={onClose}
        >
          <X size={13} />
        </Button>
      </div>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={10}
        placeholder="**Alice · 00:00** — Hey team, welcome…"
        className="mono w-full rounded-md border border-[var(--line)] bg-[var(--paper)] p-3 text-[12.5px] leading-[1.55] text-[var(--ink)] outline-none focus:border-[var(--ink-3)]"
      />
      <div className="flex items-center justify-between">
        <span className="mono text-[11px] text-[var(--ink-mute)]">
          {trimmed.length} chars
        </span>
        <div className="flex items-center gap-2">
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
                  <ClipboardPaste size={12} />
                )}
                Attach + refine
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
