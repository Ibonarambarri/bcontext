"use client";

/**
 * The review step of Autofix, rendered by `editor.tsx` once the rewrite
 * comes back from `POST /api/nodes/:id/autofix`. Pure presentation: the
 * editor holds the before/after markdown and applies the rewrite through
 * its normal save path only when `onAccept` fires.
 */
import { X } from "lucide-react";
import { Button, CloseButton, Surface } from "@heroui/react";
import { diffLines } from "@/lib/line-diff";

/**
 * Autofix review — the AI rewrite arrives here as a unified line diff and
 * NOTHING is applied until the person accepts. Field voice: mono kicker,
 * display title, hairline panel over the app tokens (both themes work).
 */
export function AutofixReview({
  before,
  after,
  model,
  segments,
  busy,
  onAccept,
  onReject,
}: {
  before: string;
  after: string;
  model: string;
  segments?: { total: number; edited: number };
  busy?: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  const lines = diffLines(before, after);
  const changed = lines.some((l) => l.type !== "same");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-5">
      <div
        className="absolute inset-0 bg-black/55 backdrop-blur-[3px]"
        onClick={onReject}
      />
      <Surface
        role="dialog"
        aria-modal="true"
        aria-label="Review autofix"
        variant="transparent"
        className="relative flex max-h-[calc(100svh-40px)] w-full max-w-[760px] flex-col rounded-[14px] border border-[var(--line)] bg-[var(--paper)] shadow-2xl"
      >
        <div className="flex items-center gap-3 border-b border-[var(--line)] px-6 py-4">
          <div className="min-w-0">
            <div
              className="mono text-[9.5px] uppercase tracking-[0.16em] text-[var(--ink-mute)]"
            >
              autofix · nothing applies until you accept
            </div>
            <h2
              className="text-[19px] leading-snug text-[var(--ink)]"
              style={{
                fontFamily: "var(--f-bricolage), var(--font-sans), sans-serif",
                fontWeight: 700,
                letterSpacing: "-0.02em",
              }}
            >
              Review the rewrite
            </h2>
          </div>
          <CloseButton
            aria-label="Close"
            onPress={onReject}
            className="ml-auto grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-[var(--line)] text-[var(--ink-3)] hover:border-[var(--line-strong)] hover:text-[var(--ink)] [&_svg]:size-[15px]"
          >
            <X size={15} />
          </CloseButton>
        </div>

        <div className="mono min-h-0 flex-1 overflow-y-auto px-4 py-3 text-[12px] leading-[1.7]">
          {changed ? (
            lines.map((l, i) => (
              <div
                key={i}
                className={
                  l.type === "add"
                    ? "whitespace-pre-wrap rounded-[3px] bg-[var(--accent-2)] px-2 text-[var(--ink)]"
                    : l.type === "del"
                      ? "whitespace-pre-wrap rounded-[3px] bg-[var(--warn-2)] px-2 text-[var(--ink-3)] line-through decoration-[var(--ink-mute)]"
                      : "whitespace-pre-wrap px-2 text-[var(--ink-2)]"
                }
              >
                {l.text || " "}
              </div>
            ))
          ) : (
            <div className="px-2 py-6 text-center text-[var(--ink-3)]">
              Already well structured. Nothing to change.
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-[var(--line)] px-6 py-4">
          <span className="mono text-[9px] uppercase tracking-[0.14em] text-[var(--ink-mute)]">
            {segments
              ? `${segments.edited}/${segments.total} sections rewritten · ${model}`
              : model}
          </span>
          <div className="ml-auto flex items-center gap-2.5">
            <Button
              variant="outline"
              onPress={onReject}
              className="h-auto rounded-md border-[var(--line)] px-4 py-1.5 text-[12.5px] text-[var(--ink-2)] hover:border-[var(--line-strong)] hover:text-[var(--ink)]"
            >
              Discard
            </Button>
            <Button
              isDisabled={!changed || busy}
              isPending={busy}
              onPress={onAccept}
              className="h-auto rounded-md bg-[var(--ink)] px-4 py-1.5 text-[12.5px] font-medium text-[var(--paper)] hover:opacity-90 disabled:opacity-50"
            >
              Accept rewrite
            </Button>
          </div>
        </div>
      </Surface>
    </div>
  );
}
