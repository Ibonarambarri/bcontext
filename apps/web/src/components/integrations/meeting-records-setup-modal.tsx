"use client";

/**
 * Mandatory setup flow for the Meeting records integration.
 *
 * Two steps (HeroUI Modal + Stepper, same pattern as
 * add-agent-modal.tsx):
 *   1. Your goal — the processing cadence (forced "Instant" for meeting
 *      records, shown locked because future integrations will offer real
 *      choices) and a required free-text objective: what should we
 *      extract from your meetings?
 *   2. Proposal — "given your goal, we'll aim to extract this for you":
 *      an editable list the user can trim, edit, extend or regenerate
 *      with feedback. Accepting persists the config and unlocks the
 *      integration.
 */
import { useEffect, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  Loader2,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  X,
  Zap,
} from "lucide-react";
import { Button, Chip, Input, Label, Modal, TextArea, TextField } from "@heroui/react";
import { Stepper } from "@/components/ui/stepper";
import { cn } from "@bcontext-dev/contract/utils";
import { workspaceApiRef, type WorkspaceAddress } from "@/web/workspace-url";

export interface ExtractionItem {
  id: string;
  label: string;
  detail: string;
}

export interface MeetingRecordsConfig {
  cadence: "instant";
  objective: string;
  extraction_items: ExtractionItem[];
  configured_at: string;
}

const MIN_OBJECTIVE_LENGTH = 12;
const STEPS = ["Your goal", "Proposal"] as const;

export function MeetingRecordsSetupModal({
  open,
  onClose,
  workspace,
  existingConfig,
  onConfigured,
}: {
  open: boolean;
  onClose: () => void;
  workspace: WorkspaceAddress;
  /** When reconfiguring, prefills objective + items. */
  existingConfig: MeetingRecordsConfig | null;
  onConfigured: (config: MeetingRecordsConfig) => void;
}) {
  const [step, setStep] = useState(0);
  const [objective, setObjective] = useState("");
  const [items, setItems] = useState<ExtractionItem[]>([]);
  const [source, setSource] = useState<"llm" | "heuristic" | null>(null);
  const [feedback, setFeedback] = useState("");
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newItemLabel, setNewItemLabel] = useState("");
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep(existingConfig ? 1 : 0);
    setObjective(existingConfig?.objective ?? "");
    setItems(existingConfig?.extraction_items ?? []);
    setSource(null);
    setFeedback("");
    setFeedbackOpen(false);
    setEditingId(null);
    setNewItemLabel("");
    setGenerating(false);
    setSaving(false);
    setError(null);
  }, [open, existingConfig]);

  const objectiveValid = objective.trim().length >= MIN_OBJECTIVE_LENGTH;

  async function generate(withFeedback: boolean) {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/integrations/meeting-records/proposal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace: workspaceApiRef(workspace),
          objective: objective.trim(),
          ...(withFeedback && feedback.trim()
            ? {
                feedback: feedback.trim(),
                previous_items: items.map(({ label, detail }) => ({ label, detail })),
              }
            : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        items?: ExtractionItem[];
        source?: "llm" | "heuristic";
        message?: string;
        error?: unknown;
      };
      if (!res.ok || !body.items) {
        throw new Error(
          body.message ?? (typeof body.error === "string" ? body.error : `HTTP ${res.status}`),
        );
      }
      setItems(body.items);
      setSource(body.source ?? null);
      setFeedback("");
      setFeedbackOpen(false);
      setStep(1);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  async function accept() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/integrations/meeting-records/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace: workspaceApiRef(workspace),
          objective: objective.trim(),
          extraction_items: items,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        config?: MeetingRecordsConfig;
        message?: string;
        error?: unknown;
      };
      if (!res.ok || !body.config) {
        throw new Error(
          body.message ?? (typeof body.error === "string" ? body.error : `HTTP ${res.status}`),
        );
      }
      onConfigured(body.config);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function updateItem(id: string, patch: Partial<Pick<ExtractionItem, "label" | "detail">>) {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }

  function addItem() {
    const label = newItemLabel.trim();
    if (!label) return;
    setItems((current) => [
      ...current,
      { id: `custom-${Date.now().toString(36)}`, label, detail: "" },
    ]);
    setNewItemLabel("");
  }

  return (
    <Modal.Backdrop
      isOpen={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog aria-label="Configure Meeting records" className="sm:max-w-[620px]">
          <Modal.CloseTrigger />
          <Modal.Header className="gap-1">
            <Modal.Heading>Configure Meeting records</Modal.Heading>
            <p className="text-[12.5px] leading-relaxed text-muted">
              {step === 0
                ? "Tell us what you want out of your meetings before the recorder goes to work."
                : "Review what we'll extract — edit, remove or add items, then accept."}
            </p>
            <Stepper orientation="horizontal" currentStep={step} size="sm" className="mt-3 w-full">
              {STEPS.map((title, index) => (
                <Stepper.Step key={title}>
                  <Stepper.Indicator />
                  <Stepper.Content className="hidden sm:block">
                    <Stepper.Title
                      className={cn("text-[11px]", index === step ? "text-foreground" : "text-muted")}
                    >
                      {title}
                    </Stepper.Title>
                  </Stepper.Content>
                  {index < STEPS.length - 1 ? <Stepper.Separator /> : null}
                </Stepper.Step>
              ))}
            </Stepper>
          </Modal.Header>

          <Modal.Body className="flex flex-col gap-4">
            {step === 0 ? (
              <>
                <div className="flex flex-col gap-1.5">
                  <span className="text-[12px] text-[var(--ink-2)]">Processing cadence</span>
                  <div className="flex items-center gap-2.5 rounded-md border border-[var(--line)] bg-[var(--paper-2)] px-3 py-2.5">
                    <Zap size={13} className="shrink-0 text-[var(--accent)]" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium">Instant</div>
                      <div className="text-[11.5px] leading-[1.5] text-[var(--ink-3)]">
                        Meeting records are processed the moment a recording arrives.
                      </div>
                    </div>
                    <Chip size="sm" variant="soft" className="shrink-0 gap-1" title="Fixed for Meeting records">
                      <Lock size={9} /> fixed
                    </Chip>
                  </div>
                  <span className="text-[11px] leading-[1.5] text-[var(--ink-mute)]">
                    Other integrations will let you pick a schedule; for meetings, instant is the
                    only cadence that makes sense.
                  </span>
                </div>

                <TextField value={objective} onChange={setObjective} className="flex flex-col gap-1.5">
                  <Label className="text-[12px] text-[var(--ink-2)]">
                    What should we extract for you?{" "}
                    <span className="text-[var(--ink-mute)]">(required)</span>
                  </Label>
                  <TextArea
                    rows={4}
                    placeholder="e.g. We run weekly product syncs — capture the decisions we make, action items with owners, and anything customers complained about."
                    className="w-full resize-none rounded-md border border-[var(--line)] bg-[var(--paper-2)] p-3 text-[13px] leading-[1.55] outline-none focus:border-[var(--ink-3)]"
                  />
                  <span
                    className={cn(
                      "text-[11px]",
                      objectiveValid ? "text-[var(--ink-mute)]" : "text-[var(--warn)]",
                    )}
                  >
                    {objectiveValid
                      ? "We'll turn this into a concrete extraction plan you can review."
                      : `At least ${MIN_OBJECTIVE_LENGTH} characters — describe your goal in a sentence or two.`}
                  </span>
                </TextField>
              </>
            ) : (
              <>
                <div className="rounded-md border border-[var(--line)] bg-[var(--paper-2)] p-3">
                  <p className="text-[12.5px] leading-[1.55] text-[var(--ink-2)]">
                    Looking at your goal, we&apos;ll aim to extract this from every meeting:
                  </p>
                  {source === "heuristic" ? (
                    <p className="mt-1 text-[11px] text-[var(--ink-mute)]">
                      Draft built without AI (deterministic fallback) — adjust it freely.
                    </p>
                  ) : null}
                </div>

                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {items.map((item) => (
                    <li
                      key={item.id}
                      className="flex items-start gap-2.5 rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5"
                    >
                      <span className="mt-0.5 shrink-0 text-[var(--accent)]">
                        <Check size={12} />
                      </span>
                      {editingId === item.id ? (
                        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                          <Input
                            autoFocus
                            value={item.label}
                            onChange={(event) => updateItem(item.id, { label: event.target.value })}
                            aria-label="Item label"
                            className="h-8 rounded-md border border-[var(--line)] bg-[var(--paper-2)] px-2 text-[12.5px] font-medium outline-none focus:border-[var(--ink-3)]"
                          />
                          <Input
                            value={item.detail}
                            onChange={(event) => updateItem(item.id, { detail: event.target.value })}
                            placeholder="What exactly will be captured…"
                            aria-label="Item detail"
                            className="h-8 rounded-md border border-[var(--line)] bg-[var(--paper-2)] px-2 text-[12px] outline-none focus:border-[var(--ink-3)]"
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            onPress={() => setEditingId(null)}
                            className="h-auto min-w-0 self-start p-0 text-[11px] text-[var(--ink-3)] hover:text-[var(--ink)]"
                          >
                            Done
                          </Button>
                        </span>
                      ) : (
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] font-medium">{item.label}</span>
                          {item.detail ? (
                            <span className="mt-0.5 block text-[12px] leading-[1.5] text-[var(--ink-3)]">
                              {item.detail}
                            </span>
                          ) : null}
                        </span>
                      )}
                      <span className="flex shrink-0 items-center gap-0.5">
                        <Button
                          variant="ghost"
                          isIconOnly
                          onPress={() => setEditingId(editingId === item.id ? null : item.id)}
                          aria-label={`Edit ${item.label}`}
                          className="h-auto min-w-0 rounded-md p-1 text-[var(--ink-3)] hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
                        >
                          <Pencil size={11} />
                        </Button>
                        <Button
                          variant="ghost"
                          isIconOnly
                          onPress={() =>
                            setItems((current) => current.filter((other) => other.id !== item.id))
                          }
                          aria-label={`Remove ${item.label}`}
                          className="h-auto min-w-0 rounded-md p-1 text-[var(--ink-3)] hover:bg-[var(--paper-2)] hover:text-red-500"
                        >
                          <X size={11} />
                        </Button>
                      </span>
                    </li>
                  ))}
                  {items.length === 0 ? (
                    <li className="rounded-md border border-dashed border-[var(--line)] px-3 py-4 text-center text-[12px] text-[var(--ink-mute)]">
                      Nothing left — add at least one item or regenerate the proposal.
                    </li>
                  ) : null}
                </ul>

                <div className="flex items-center gap-2">
                  <Input
                    value={newItemLabel}
                    onChange={(event) => setNewItemLabel(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") addItem();
                    }}
                    placeholder="Add your own item…"
                    aria-label="Add your own item"
                    className="h-8 min-w-0 flex-1 rounded-md border border-[var(--line)] bg-[var(--paper-2)] px-2.5 text-[12.5px] outline-none focus:border-[var(--ink-3)]"
                  />
                  <Button
                    variant="outline"
                    isDisabled={!newItemLabel.trim()}
                    onPress={addItem}
                    className="h-8 min-w-0 gap-1 rounded-md border-[var(--line)] px-2.5 text-[12px]"
                  >
                    <Plus size={11} /> Add
                  </Button>
                </div>

                {feedbackOpen ? (
                  <div className="flex flex-col gap-2 rounded-md border border-[var(--line)] bg-[var(--paper-2)] p-3">
                    <TextField value={feedback} onChange={setFeedback} className="flex flex-col gap-2">
                      <Label className="text-[12px] text-[var(--ink-2)]">
                        What should change in this proposal?
                      </Label>
                      <TextArea
                        autoFocus
                        rows={2}
                        placeholder="e.g. Focus on customer complaints, drop the metrics item."
                        className="w-full resize-none rounded-md border border-[var(--line)] bg-[var(--paper)] p-2 text-[12.5px] outline-none focus:border-[var(--ink-3)]"
                      />
                    </TextField>
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onPress={() => setFeedbackOpen(false)}
                        className="h-7 min-w-0 px-2 text-[11.5px] text-[var(--ink-3)]"
                      >
                        Cancel
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        isDisabled={!feedback.trim() || generating}
                        onPress={() => void generate(true)}
                        className="h-7 min-w-0 gap-1.5 rounded-md border-[var(--line)] px-2.5 text-[11.5px]"
                      >
                        {generating ? (
                          <Loader2 size={11} className="animate-spin" />
                        ) : (
                          <RefreshCw size={11} />
                        )}
                        Regenerate
                      </Button>
                    </div>
                  </div>
                ) : null}
              </>
            )}

            {error ? (
              <div className="flex items-start gap-2 rounded-md border border-[var(--warn-2)] bg-[var(--warn-2)] p-2.5 text-[12px] text-[var(--warn)]">
                <AlertCircle size={13} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            ) : null}
          </Modal.Body>

          <Modal.Footer>
            {step === 0 ? (
              <>
                <Button variant="secondary" slot="close">
                  Cancel
                </Button>
                <span className="flex-1" />
                <Button
                  isDisabled={!objectiveValid || generating}
                  onPress={() => void generate(false)}
                  className="gap-1.5"
                >
                  {generating ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Sparkles size={12} />
                  )}
                  Generate proposal
                </Button>
              </>
            ) : (
              <>
                <Button variant="secondary" onPress={() => setStep(0)} className="gap-1.5">
                  <ArrowLeft size={12} /> Goal
                </Button>
                {!feedbackOpen ? (
                  <Button
                    variant="ghost"
                    onPress={() => setFeedbackOpen(true)}
                    className="min-w-0 px-2 text-[12px] text-[var(--ink-3)] underline decoration-[var(--line)] underline-offset-2 hover:text-[var(--ink)]"
                  >
                    Ask for changes
                  </Button>
                ) : null}
                <span className="flex-1" />
                <Button
                  isDisabled={items.length === 0 || saving || generating}
                  onPress={() => void accept()}
                  className="gap-1.5"
                >
                  {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                  Accept &amp; activate
                </Button>
              </>
            )}
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
