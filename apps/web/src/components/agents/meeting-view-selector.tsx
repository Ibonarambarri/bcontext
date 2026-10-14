"use client";

/**
 * Refined / Transcript selector for meeting nodes (`meeting-node-view.tsx`).
 *
 * A small segmented control rendered inside the node header on
 * /w/<org>/<ws>/n/<id> when:
 *   - node.kind === "meeting"
 *   - node.data.transcript_md exists
 *
 * Behaviour:
 *   - When refine_status === "done": both options enabled, defaults to
 *     "Refined" (= node.content_md).
 *   - When refine_status === "pending": "Refined" tab shows a spinner;
 *     view defaults to "Transcript" so the user can read something.
 *   - When refine_status === "failed" / "skipped": shows the small chip
 *     with the reason next to the selector; user can retry via the
 *     refine endpoint (POST /api/meetings/refine/[nodeId]).
 *
 * State lives in the URL via the `view=` query param so deep-linking
 * (eg. from a chat citation) preserves the choice. Defaults are computed
 * client-side from the node's current `refine_status`.
 */
import { useRouter } from "next/navigation";
import { Loader2, AlertCircle, RotateCw, FileText, Sparkles } from "lucide-react";
import { useCallback, useState } from "react";
import { Button, Chip } from "@heroui/react";
import { useToast } from "@/components/workspace-context";
import type { RefineStatus } from "@bcontext-dev/contract/meetings";
import type { MeetingView } from "@/lib/meetings/view";

export function MeetingViewSelector({
  view,
  status,
  refineError,
  nodeId,
  onChange,
}: {
  view: MeetingView;
  status: RefineStatus | undefined;
  refineError: string | null;
  nodeId: string;
  onChange: (next: MeetingView) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [retrying, setRetrying] = useState(false);
  const refineReady = status === "done";
  const refineLoading = status === "pending" || status === undefined;
  const refineFailed = status === "failed" || status === "skipped";

  const select = useCallback(
    (next: MeetingView) => {
      if (next === view) return;
      const url = new URL(window.location.href);
      if (next === "transcript") url.searchParams.set("view", "transcript");
      else url.searchParams.delete("view");
      window.history.replaceState(null, "", url.toString());
      onChange(next);
    },
    [view, onChange],
  );

  const retry = useCallback(async () => {
    setRetrying(true);
    try {
      const res = await fetch(`/api/meetings/refine/${nodeId}`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const message =
          typeof body.message === "string"
            ? body.message
            : typeof body.error === "string"
              ? body.error
              : `Retry failed (${res.status})`;
        toast.error(message);
        return;
      }
      toast.info("Refining transcript…");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setRetrying(false);
    }
  }, [nodeId, router, toast]);

  return (
    <div className="mt-3 flex items-center gap-2">
      <div
        role="tablist"
        aria-label="Meeting view"
        className="inline-flex items-center gap-0.5 rounded-md border border-[var(--line)] bg-[var(--paper-2)] p-0.5"
      >
        <SegBtn
          active={view === "refined"}
          disabled={!refineReady && !refineFailed}
          onClick={() => select("refined")}
          label="Refined"
          icon={
            refineLoading ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <Sparkles size={11} />
            )
          }
        />
        <SegBtn
          active={view === "transcript"}
          disabled={false}
          onClick={() => select("transcript")}
          label="Transcript"
          icon={<FileText size={11} />}
        />
      </div>

      {refineLoading && (
        <Chip size="sm" variant="soft" color="default">
          <Chip.Label className="mono text-[11px]">refining…</Chip.Label>
        </Chip>
      )}
      {refineFailed && (
        <Chip size="sm" variant="soft" color="warning" title={refineError ?? undefined}>
          <Chip.Label className="mono inline-flex items-center gap-1 text-[11px]">
            <AlertCircle size={11} />
            {status === "skipped" ? "skipped — transcript too short" : "refine failed"}
          </Chip.Label>
        </Chip>
      )}
      {(refineFailed || refineReady) && (
        <Button
          variant="outline"
          size="sm"
          className="mono h-6 gap-1 rounded border border-[var(--line)] bg-[var(--paper)] px-2 text-[11px] text-[var(--ink-2)]"
          isDisabled={retrying}
          isPending={retrying}
          onPress={() => void retry()}
        >
          {({ isPending }) => (
            <>
              {isPending ? (
                <Loader2 size={10} className="animate-spin" />
              ) : (
                <RotateCw size={10} />
              )}
              {refineFailed ? "retry" : "re-refine"}
            </>
          )}
        </Button>
      )}
    </div>
  );
}

function SegBtn({
  active,
  disabled,
  onClick,
  label,
  icon,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      isDisabled={disabled}
      onPress={onClick}
      render={(props) => <button {...props} aria-selected={active} role="tab" />}
      className={
        "h-6 gap-1.5 rounded px-2 text-[11.5px] transition-colors " +
        (active
          ? "bg-[var(--paper)] text-[var(--ink)] shadow-[0_1px_0_rgba(0,0,0,0.04)]"
          : "text-[var(--ink-2)] hover:text-[var(--ink)]")
      }
    >
      {icon}
      {label}
    </Button>
  );
}
