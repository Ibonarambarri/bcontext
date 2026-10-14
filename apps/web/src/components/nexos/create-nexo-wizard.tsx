"use client";

/**
 * Making a Nexo: pick what it looks after → four short answers (the rest
 * under "More options", with the template's defaults) → read the
 * instructions Bcontext writes from them → create.
 *
 * Opened from the Nexos page (`nexos-page.tsx`), lazily. The questionnaire is
 * the contract's (`NexoQuestionnaire`); the template only pre-fills it. The
 * third step asks the API for the instructions without creating anything
 * (`POST /api/nexos` with `preview: true`) and shows them rendered; "Edit"
 * switches to the raw Markdown. Create sends that text as `prompt_md`, so the
 * stored prompt is exactly what the person read. Nothing exists until Create;
 * closing earlier leaves no trace.
 *
 * A routine answer means the person wants it to check on its own: Create
 * then turns the heartbeat on in the browser's timezone.
 *
 * Controls are local to this file on purpose: the Nexo's Setup page has its
 * own, and a wizard is short-lived enough to keep its chips compact and its
 * selected states neutral (the workspace accent can be red, and a red border
 * on a choice reads as an error).
 */
import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown, Pencil, Eye } from "lucide-react";
import {
  Button,
  Description,
  Input,
  Label,
  ListBox,
  Modal,
  Select,
  Spinner,
  TextArea,
  TextField,
} from "@heroui/react";
import { cn } from "@bcontext-dev/contract/utils";
import { ProviderLogo } from "@/components/integrations/provider-logo";
import { NATIVE_CATALOG } from "@/lib/integrations/catalog";
import { nexosApi } from "@/lib/nexos/api";
import {
  NEXO_CAN_DO,
  NEXO_TEMPLATES,
  NEXO_TONES,
  nexoTemplate,
  type CreateNexoBody,
  type Nexo,
  type NexoCanDo,
  type NexoQuestionnaire,
  type NexoTemplateKey,
  type NexoTone,
} from "@bcontext-dev/contract/nexos";
import type { WorkspaceAddress } from "@/web/workspace-url";
import { NexoFace } from "./nexo-face";
import { canDoLabel, toneLabel } from "./nexo-copy";

const SOURCE_CHOICES = NATIVE_CATALOG.filter((entry) => entry.key !== "meeting-bot");

/**
 * Languages offered, by the name the prompt uses ("respondes en español",
 * not "en es"). The API also maps codes to names, but the name is what the
 * person reads back in the instructions, so the name is what is sent.
 */
const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "es", name: "español" },
  { code: "ca", name: "català" },
  { code: "eu", name: "euskara" },
  { code: "gl", name: "galego" },
  { code: "pt", name: "português" },
  { code: "fr", name: "français" },
  { code: "de", name: "Deutsch" },
  { code: "it", name: "italiano" },
] as const;

/** A code ("es", "es-ES") or a name ("Español") → the name in the list. */
function languageName(value: string): string {
  const v = value.trim().toLowerCase();
  const hit = LANGUAGES.find((l) => l.name.toLowerCase() === v || v === l.code || v.startsWith(`${l.code}-`));
  return hit ? hit.name : value.trim() || "English";
}

function speaksSpanish(): boolean {
  return typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("es");
}

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** A template's display name and line, in the UI's language. */
export function templateCopy(key: string): { name: string; description: string } {
  const template = nexoTemplate(key);
  if (!template) return { name: "Nexo", description: "" };
  return template.en;
}

/**
 * The answers a template starts from. The presets are written in Spanish;
 * for anyone else the free-text answers start from the English description
 * instead of Spanish prose they would have to rewrite.
 */
function prefill(key: NexoTemplateKey): NexoQuestionnaire {
  const template = nexoTemplate(key) ?? nexoTemplate("custom")!;
  if (speaksSpanish()) {
    return { ...template.questionnaire, language: languageName(template.questionnaire.language || "es") };
  }
  return {
    ...template.questionnaire,
    name: key === "custom" ? "" : template.en.name,
    mission: key === "custom" ? "" : template.en.description,
    escalate_when: "",
    routine: "",
    language: "English",
  };
}

/** The create body; `preview` is a separate call, never sent from here. */
type CreateBody = Omit<CreateNexoBody, "preview">;

const STEP_COPY = [
  "What will it look after? You can change everything later.",
  "A few short answers. Bcontext writes its instructions from them.",
  "What it will follow on every run. Edit it now or any time later.",
] as const;

export function CreateNexoWizard({
  workspace,
  initialTemplate,
  onClose,
  onCreated,
  onOpen,
}: {
  workspace: WorkspaceAddress;
  /** A suggestion card starts on the questions with its template chosen. */
  initialTemplate: string | null;
  onClose: () => void;
  onCreated: (nexo: Nexo) => void;
  onOpen: (nexo: Nexo) => void;
}) {
  const startKey = (nexoTemplate(initialTemplate ?? "")?.key ?? "custom") as NexoTemplateKey;
  const [step, setStep] = useState(initialTemplate ? 1 : 0);
  const [template, setTemplate] = useState<NexoTemplateKey>(startKey);
  const [answers, setAnswers] = useState<NexoQuestionnaire>(() => prefill(startKey));
  const [moreOpen, setMoreOpen] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [editing, setEditing] = useState(false);

  const set = <K extends keyof NexoQuestionnaire>(key: K, value: NexoQuestionnaire[K]) =>
    setAnswers((current) => ({ ...current, [key]: value }));

  // Picking a tile is the choice: it moves straight on. Anything already
  // typed is kept; a template only fills what is empty.
  const pickTemplate = (key: NexoTemplateKey) => {
    setTemplate(key);
    setAnswers((current) => {
      const fresh = prefill(key);
      return {
        ...fresh,
        name: current.name.trim() ? current.name : fresh.name,
        mission: current.mission.trim() ? current.mission : fresh.mission,
      };
    });
    setStep(1);
  };

  const name = answers.name.trim();
  const canContinue = name.length > 0 && answers.mission.trim().length > 0;

  const cleaned = (): NexoQuestionnaire => ({
    ...answers,
    name,
    mission: answers.mission.trim(),
    escalate_when: answers.escalate_when.trim(),
    routine: answers.routine.trim(),
    language: languageName(answers.language),
  });

  // The instructions are written from the answers by the API (a model call:
  // several seconds). The third step opens at once with a visible "writing"
  // state instead of a button that just spins.
  const preview = async () => {
    if (!canContinue || previewing) return;
    setPreviewing(true);
    setEditing(false);
    setError(null);
    setStep(2);
    try {
      const result = await nexosApi.preview(workspace, { template, questionnaire: cleaned() });
      setPrompt(result.prompt_md);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPreviewing(false);
    }
  };

  const create = async () => {
    if (creating || !prompt.trim()) return;
    setCreating(true);
    setError(null);
    const questionnaire = cleaned();
    const body: CreateBody = {
      template,
      questionnaire,
      prompt_md: prompt.trim(),
      ...(questionnaire.routine ? { heartbeat: { enabled: true, active_hours: { tz: browserTimezone() } } } : {}),
    };
    try {
      const nexo: Nexo = await nexosApi.create(workspace, body as Omit<CreateNexoBody, "preview">);
      onCreated(nexo);
      onOpen(nexo);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const faceName = name || (template === "custom" ? "Nexo" : templateCopy(template).name);
  const busy = previewing || creating;

  return (
    <Modal.Backdrop
      isOpen
      onOpenChange={(open) => {
        if (!open && !creating) onClose();
      }}
    >
      <Modal.Container size="md" scroll="inside">
        <Modal.Dialog aria-label="New Nexo" className="relative sm:max-w-[560px]">
          <Modal.CloseTrigger />
          <Modal.Header className="gap-0 pr-10">
            <div className="flex items-center gap-3">
              <NexoFace name={faceName} size={36} animate={previewing ? "always" : undefined} />
              <div className="min-w-0">
                <Modal.Heading className="truncate">{step === 0 || !name ? "New Nexo" : name}</Modal.Heading>
                <p className="m-0 text-[12.5px] leading-relaxed text-muted">{STEP_COPY[step]}</p>
              </div>
            </div>
            <StepDots step={step} />
          </Modal.Header>

          <Modal.Body className="flex flex-col gap-5">
            {step === 0 ? <TemplateStep onPick={pickTemplate} /> : null}

            {step === 1 ? (
              <>
                <Field
                  label="Name"
                  value={answers.name}
                  onChange={(v) => set("name", v)}
                  placeholder="Marketing, Support, People…"
                  autoFocus
                />
                <Field
                  label="What does it look after?"
                  value={answers.mission}
                  onChange={(v) => set("mission", v)}
                  placeholder="Customer questions in #support and the bugs they uncover."
                  rows={2}
                />
                <SourcesPicker value={answers.sources} onChange={(v) => set("sources", v)} />
                <Field
                  label="When should it come to you?"
                  value={answers.escalate_when}
                  onChange={(v) => set("escalate_when", v)}
                  placeholder="A customer complains about billing, or anything it is not sure about."
                  rows={2}
                />

                <div>
                  <button
                    type="button"
                    aria-expanded={moreOpen}
                    onClick={() => setMoreOpen((v) => !v)}
                    className="flex cursor-[var(--cursor-interactive)] items-center gap-1.5 border-0 bg-transparent p-0 text-[12.5px] font-medium text-muted transition-colors duration-150 hover:text-foreground"
                  >
                    <ChevronDown
                      size={14}
                      aria-hidden="true"
                      className={cn("transition-transform duration-200 ease-out", moreOpen ? "rotate-0" : "-rotate-90")}
                    />
                    More options
                    {!moreOpen ? (
                      <span className="font-normal text-[var(--ink-mute)]">
                        · {toneLabel(answers.tone)}, {capitalize(languageName(answers.language))}
                        {answers.routine.trim() ? ", checks on its own" : ""}
                      </span>
                    ) : null}
                  </button>
                  {moreOpen ? (
                    <div className="mt-4 flex flex-col gap-5">
                      <ChipGroup
                        legend="What can it do without asking?"
                        options={NEXO_CAN_DO.map((key) => ({ key, label: canDoLabel(key) }))}
                        selected={answers.can_do_alone}
                        onToggle={(key) =>
                          set(
                            "can_do_alone",
                            answers.can_do_alone.includes(key as NexoCanDo)
                              ? answers.can_do_alone.filter((k) => k !== key)
                              : [...answers.can_do_alone, key as NexoCanDo],
                          )
                        }
                      />
                      <div className="grid grid-cols-1 gap-5 sm:grid-cols-[1fr_180px]">
                        <ChipGroup
                          legend="Tone"
                          options={NEXO_TONES.map((key) => ({ key, label: toneLabel(key) }))}
                          selected={[answers.tone]}
                          onToggle={(key) => set("tone", key as NexoTone)}
                        />
                        <LanguageSelect value={answers.language} onChange={(v) => set("language", v)} />
                      </div>
                      <Field
                        label="What should it check on its own?"
                        hint="Leave empty and it only works when something arrives. Filled, it checks a few times a day during working hours."
                        value={answers.routine}
                        onChange={(v) => set("routine", v)}
                        placeholder="Unanswered threads older than two hours; anything that mentions a refund."
                        rows={2}
                      />
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}

            {step === 2 ? (
              previewing ? (
                <div role="status" className="flex min-h-[240px] flex-col items-center justify-center gap-3 text-center">
                  <Spinner size="sm" />
                  <p className="m-0 text-[13px] font-medium text-foreground">Writing its instructions…</p>
                  <p className="m-0 max-w-[320px] text-[12px] leading-relaxed text-muted">
                    Bcontext turns your answers into what {name || "it"} reads on every run. It takes a few seconds.
                  </p>
                </div>
              ) : prompt ? (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[13px] font-medium text-foreground">Instructions</span>
                    <Button size="sm" variant="ghost" className="gap-1.5" onPress={() => setEditing((v) => !v)}>
                      {editing ? <Eye size={13} /> : <Pencil size={13} />}
                      {editing ? "Preview" : "Edit"}
                    </Button>
                  </div>
                  {editing ? (
                    <TextField value={prompt} onChange={setPrompt} fullWidth aria-label="Instructions">
                      <TextArea rows={16} variant="secondary" className="mono text-[12px] leading-[1.6]" autoFocus />
                      <Description className="text-[11.5px]">Markdown. Keep the headings: it reads them on every run.</Description>
                    </TextField>
                  ) : (
                    <div className="chat-md max-h-[46vh] overflow-y-auto rounded-xl bg-[var(--paper-2)] px-4 py-3">
                      <div className="markdown">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{prompt}</ReactMarkdown>
                      </div>
                    </div>
                  )}
                </div>
              ) : null
            ) : null}

            {error ? (
              <div role="alert" className="flex items-center justify-between gap-3 text-[12.5px] text-danger">
                <span>{error}</span>
                {step === 2 && !prompt ? (
                  <Button size="sm" variant="secondary" onPress={() => void preview()}>
                    Try again
                  </Button>
                ) : null}
              </div>
            ) : null}
          </Modal.Body>

          <Modal.Footer>
            {step === 0 ? (
              <Button variant="secondary" slot="close">
                Cancel
              </Button>
            ) : (
              <Button variant="secondary" onPress={() => setStep(step - 1)} isDisabled={busy}>
                Back
              </Button>
            )}
            <span className="flex-1" />
            {step === 1 ? (
              <Button onPress={() => void preview()} isDisabled={!canContinue}>
                Continue
              </Button>
            ) : null}
            {step === 2 ? (
              <Button onPress={() => void create()} isDisabled={!prompt.trim() || previewing} isPending={creating}>
                Create {name || "Nexo"}
              </Button>
            ) : null}
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

/** Three small dots instead of a labelled stepper: the subtitle says where you are. */
function StepDots({ step }: { step: number }) {
  return (
    <div className="mt-3 flex items-center gap-1.5" aria-label={`Step ${step + 1} of 3`} role="img">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={cn(
            "h-1 rounded-full transition-[width,background-color] duration-200 ease-out",
            i === step ? "w-5 bg-foreground" : i < step ? "w-2.5 bg-[var(--ink-3)]" : "w-2.5 bg-[var(--line-strong)]",
          )}
        />
      ))}
    </div>
  );
}

/**
 * Seven small tiles that fit without scrolling. Nothing is preselected:
 * clicking one is the choice and moves on. "Custom" sits last, same size.
 */
function TemplateStep({ onPick }: { onPick: (key: NexoTemplateKey) => void }) {
  return (
    <ul className="m-0 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-3" aria-label="Templates">
      {NEXO_TEMPLATES.map((template) => (
        <li key={template.key} className="min-w-0">
          <button
            type="button"
            onClick={() => onPick(template.key)}
            className="avatar-wake flex h-full w-full cursor-[var(--cursor-interactive)] flex-col items-start gap-2 rounded-xl border border-[var(--line)] bg-transparent p-3 text-left transition-[border-color,background-color,transform] duration-150 ease-out hover:border-[var(--line-strong)] hover:bg-[var(--paper-2)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ink-3)] active:scale-[0.98]"
          >
            <NexoFace name={template.key === "custom" ? "Nexo" : template.en.name} size={28} animate="hover" />
            <span className="text-[13px] font-medium leading-tight text-foreground">
              {template.key === "custom" ? "Start blank" : template.en.name}
            </span>
            <span className="line-clamp-2 text-[11.5px] leading-[1.45] text-muted">{template.en.description}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
  rows,
  autoFocus,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
}) {
  return (
    <TextField value={value} onChange={onChange} fullWidth>
      <Label>{label}</Label>
      {rows ? (
        <TextArea rows={rows} placeholder={placeholder} autoFocus={autoFocus} variant="secondary" className="text-[13px] leading-[1.55]" />
      ) : (
        <Input placeholder={placeholder} autoFocus={autoFocus} variant="secondary" />
      )}
      {hint ? <Description className="text-[11.5px]">{hint}</Description> : null}
    </TextField>
  );
}

/**
 * Compact toggle chips. Selected = filled neutral surface and a stronger
 * border; never the accent, which can read as an error colour.
 */
function ChipGroup({
  legend,
  options,
  selected,
  onToggle,
}: {
  legend: string;
  options: { key: string; label: string }[];
  selected: readonly string[];
  onToggle: (key: string) => void;
}) {
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0">
      <legend className="mb-2 text-[13px] font-medium text-foreground">{legend}</legend>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={legend}>
        {options.map(({ key, label }) => {
          const on = selected.includes(key);
          return (
            <Button
              key={key}
              size="sm"
              variant={on ? "secondary" : "outline"}
              aria-pressed={on}
              className={cn(on && "border-[var(--line-strong)] text-foreground", !on && "text-muted")}
              onPress={() => onToggle(key)}
            >
              {label}
            </Button>
          );
        })}
      </div>
    </fieldset>
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function LanguageSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const current = languageName(value);
  const options = LANGUAGES.some((l) => l.name === current)
    ? LANGUAGES.map((l) => l.name)
    : [current, ...LANGUAGES.map((l) => l.name)];
  return (
    <Select
      variant="secondary"
      selectedKey={current}
      onSelectionChange={(key) => {
        if (key !== null) onChange(String(key));
      }}
    >
      <Label>Language</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {options.map((name) => (
            <ListBox.Item key={name} id={name} textValue={capitalize(name)}>
              <Label>{capitalize(name)}</Label>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

/**
 * Which sources it should watch, as intent: binding a real install (and its
 * channels) happens on the Nexo's page, where the installs are.
 */
function SourcesPicker({ value, onChange }: { value: string[]; onChange: (value: string[]) => void }) {
  const selected = useMemo(() => new Set(value), [value]);
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0">
      <legend className="mb-2 text-[13px] font-medium text-foreground">Where does that happen?</legend>
      <div className="flex flex-wrap gap-1.5">
        {SOURCE_CHOICES.map((entry) => {
          const on = selected.has(entry.key);
          return (
            <Button
              key={entry.key}
              size="sm"
              variant={on ? "secondary" : "outline"}
              aria-pressed={on}
              className={cn("gap-2", on ? "border-[var(--line-strong)] text-foreground" : "text-muted")}
              onPress={() => onChange(on ? value.filter((k) => k !== entry.key) : [...value, entry.key])}
            >
              <ProviderLogo name={entry.name} logoUrl={entry.logo_url} connectorId={entry.key} size={16} className="rounded-[4px] border-0 bg-transparent" />
              {entry.name}
            </Button>
          );
        })}
      </div>
      <p className="m-0 mt-1.5 text-[11.5px] text-muted">You connect the actual accounts and channels from its page once it exists.</p>
    </fieldset>
  );
}
