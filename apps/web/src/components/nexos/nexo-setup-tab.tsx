"use client";

/**
 * A Nexo's Setup tab: everything about how it is set up, on one scrolling
 * page, in the order people reach for it —
 *
 *   Sources         what it listens to (`nexo-sources.tsx`)
 *   What it can do  brain read/write and external tools (`nexo-abilities.tsx`)
 *   How it works    autonomy and its routine
 *   Who it tells    escalation recipients and email
 *   Instructions    name, description and the prompt (collapsed, rendered)
 *   Budget          a monthly cap of its own
 *   Danger zone     pause, delete
 *
 * Each section is an anchor (`#nexo-<section>`); `?section=` scrolls to it,
 * which is how the retired `?tab=integrations|tools|settings` links land.
 *
 * One save pattern: every control saves itself, optimistically, through the
 * detail's `onUpdate` (a refusal puts it back and says why in a toast).
 * Text saves on blur, or with the Save that appears while it differs. The
 * instructions are a long document, so they are edited deliberately: Edit,
 * then Save or Cancel. Rewriting them from the questionnaire and deleting
 * the Nexo are the two destructive acts and the only ones that confirm.
 *
 * Recipients come from `GET /api/workspaces/:ws/members` (people only).
 */
import { useEffect, useState } from "react";
import { Button, Checkbox, Disclosure, Label, ListBox, NumberField, Select } from "@heroui/react";
import { Pause, Pencil, Play } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { PersonAvatar } from "@/components/person-avatar";
import { useToast } from "@/components/workspace-context";
import type { Nexo, NexoBinding, NexoHeartbeat, UpdateNexoBody } from "@bcontext-dev/contract/nexos";
import { nexosApi, type NexoView } from "@/lib/nexos/api";
import type { NexoSetupSection } from "@/lib/view-shell";
import { workspaceApiRef, type WorkspaceAddress } from "@/web/workspace-url";
import { NexoAbilities } from "./nexo-abilities";
import { everyLabel } from "./nexo-copy";
import { AutoSaveText, AutonomyPicker, SettingSwitch, TextQuestion } from "./nexo-fields";
import { NexoRichText } from "./nexo-rich-text";
import { NexoSources } from "./nexo-sources";

const EVERY_CHOICES = [15, 30, 60, 120, 240, 1440];

type Update = (patch: UpdateNexoBody, success?: string) => Promise<boolean>;

interface Member {
  userId: string;
  email: string | null;
  name: string | null;
  role: string;
}

/** The DOM id of a section, for anchors and `?section=`. */
export function setupSectionId(section: NexoSetupSection): string {
  return `nexo-${section}`;
}

export function NexoSetupTab({
  workspace,
  nexo,
  section,
  onUpdate,
  onReplace,
  onBindingsChange,
  onDeleted,
}: {
  workspace: WorkspaceAddress;
  nexo: NexoView;
  /** The section to scroll to on arrival. */
  section: NexoSetupSection | null;
  onUpdate: Update;
  onReplace: (next: Nexo) => void;
  onBindingsChange: (bindings: NexoBinding[]) => void;
  onDeleted: () => void;
}) {
  const toast = useToast();

  useEffect(() => {
    if (!section) return;
    requestAnimationFrame(() => document.getElementById(setupSectionId(section))?.scrollIntoView({ block: "start" }));
  }, [section]);

  return (
    <div className="flex max-w-[760px] flex-col gap-12">
      <Section id="sources" title="Sources" hint={sourcesHint(nexo)}>
        <NexoSources workspace={workspace} nexo={nexo} onBindingsChange={onBindingsChange} />
      </Section>

      <Section id="abilities" title="What it can do">
        <NexoAbilities workspace={workspace} nexo={nexo} onUpdate={onUpdate} />
      </Section>

      <Section id="behaviour" title="How it works" hint="How far it may go when it writes to people, and whether it checks in on its own.">
        <div className="flex flex-col gap-6">
          <AutonomyPicker
            value={nexo.autonomy}
            onChange={(autonomy) =>
              void onUpdate(
                { autonomy },
                `${nexo.name} now ${autonomy === "observe" ? "only observes" : autonomy === "draft" ? "drafts replies for you" : "replies on its own"}.`,
              )
            }
          />
          <Routine nexo={nexo} onUpdate={onUpdate} />
        </div>
      </Section>

      <Section id="escalation" title="Who it tells" hint="When it needs a person, it says so in its Inbox. These people are told as well.">
        <Escalation workspace={workspace} nexo={nexo} onUpdate={onUpdate} />
      </Section>

      <Section id="instructions" title="Instructions" hint="Who it is and what it follows on every run.">
        <Instructions workspace={workspace} nexo={nexo} onUpdate={onUpdate} onReplace={onReplace} />
      </Section>

      <Section id="budget" title="Budget">
        <Budget nexo={nexo} onUpdate={onUpdate} />
      </Section>

      <Section id="danger" title="Danger zone">
        <DangerZone
          nexo={nexo}
          onUpdate={onUpdate}
          onDelete={async () => {
            try {
              await nexosApi.remove(workspace, nexo.id);
              onDeleted();
            } catch (e) {
              toast.error(`Couldn't delete it: ${(e as Error).message}`);
            }
          }}
        />
      </Section>
    </div>
  );
}

function sourcesHint(nexo: NexoView): string {
  return nexo.is_general
    ? "Everything no other Nexo has claimed, plus anything you give it here."
    : `What arrives here reaches ${nexo.name}; it feeds the brain and decides whether to reply or ask you.`;
}

function Section({
  id,
  title,
  hint,
  children,
}: {
  id: NexoSetupSection;
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={setupSectionId(id)} aria-labelledby={`${setupSectionId(id)}-title`} className="scroll-mt-6">
      <h2 id={`${setupSectionId(id)}-title`} className="m-0 text-[15px] font-medium text-foreground">
        {title}
      </h2>
      {hint ? <p className="m-0 mt-0.5 text-[12px] leading-[1.5] text-[var(--ink-3)]">{hint}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** "every 2 h" → "Every 2 h": only the first letter, so units keep their case. */
function sentence(text: string): string {
  return text.replace(/^./, (c) => c.toUpperCase());
}

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * The routine: one switch, and while it is on, how often, between which
 * hours and what to look at. Each control saves the whole heartbeat with its
 * one change, built on the copy on screen (already optimistic), so two quick
 * changes never undo each other.
 */
function Routine({ nexo, onUpdate }: { nexo: NexoView; onUpdate: Update }) {
  const heartbeat: NexoHeartbeat = {
    enabled: nexo.heartbeat?.enabled ?? false,
    every_minutes: nexo.heartbeat?.every_minutes ?? 60,
    active_hours: nexo.heartbeat?.active_hours ?? { start: "09:00", end: "19:00", tz: browserTimeZone() },
    checklist_md: nexo.heartbeat?.checklist_md ?? "",
  };
  const hours = heartbeat.active_hours;
  const save = (patch: Partial<NexoHeartbeat>, success?: string) => onUpdate({ heartbeat: { ...heartbeat, ...patch } }, success);
  const setHours = (patch: Partial<NexoHeartbeat["active_hours"]>) => save({ active_hours: { ...hours, ...patch } });

  return (
    <div className="flex flex-col gap-5">
      <SettingSwitch
        title="Check on its own"
        description={
          heartbeat.enabled
            ? `${sentence(everyLabel(heartbeat.every_minutes))}, ${hours.start}–${hours.end} (${hours.tz}). It only speaks up when it finds something.`
            : "Off: it only works when a message arrives or someone talks to it."
        }
        isSelected={heartbeat.enabled}
        onChange={(enabled) =>
          void save(
            // The UTC default is nobody's working day: switching on takes the browser's zone.
            enabled && hours.tz === "UTC" ? { enabled, active_hours: { ...hours, tz: browserTimeZone() } } : { enabled },
          )
        }
      />

      {heartbeat.enabled ? (
        <>
          <div className="grid grid-cols-1 gap-3 min-[520px]:grid-cols-3">
            <Select
              aria-label="How often"
              selectedKey={String(heartbeat.every_minutes)}
              onSelectionChange={(key) => void save({ every_minutes: Number(key) })}
              variant="secondary"
            >
              <Label>How often</Label>
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {EVERY_CHOICES.map((minutes) => (
                    <ListBox.Item key={minutes} id={String(minutes)} textValue={everyLabel(minutes)}>
                      <Label>{sentence(everyLabel(minutes))}</Label>
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
            <TimeInput label="From" value={hours.start} onCommit={(start) => void setHours({ start })} />
            <TimeInput label="Until" value={hours.end} onCommit={(end) => void setHours({ end })} />
          </div>
          <AutoSaveText
            label="Time zone"
            value={hours.tz}
            required
            onSave={(tz) => setHours({ tz })}
            hint="Its working hours are read in this zone, e.g. Europe/Madrid."
          />
          <AutoSaveText
            label="What to check"
            hint="One item per line. If there is nothing to do, it stays quiet."
            value={heartbeat.checklist_md}
            onSave={(checklist_md) => save({ checklist_md })}
            rows={4}
            placeholder={"- Threads without an answer for two hours\n- Anything that mentions a refund"}
          />
        </>
      ) : null}
    </div>
  );
}

/** A native time input in the house field style; saves when it loses focus, not on every digit. */
function TimeInput({ label, value, onCommit }: { label: string; value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[13px] font-medium text-foreground">{label}</span>
      <input
        type="time"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft && draft !== value) onCommit(draft);
          else setDraft(value);
        }}
        className="h-9 rounded-[var(--radius-field,10px)] border border-transparent bg-[var(--field-background,var(--paper-2))] px-3 text-[13px] tabular-nums text-foreground outline-none focus-visible:border-[var(--accent)]"
      />
    </label>
  );
}

function Escalation({ workspace, nexo, onUpdate }: { workspace: WorkspaceAddress; nexo: NexoView; onUpdate: Update }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const escalation = nexo.escalation ?? { notify_user_ids: [], via: ["inbox"] };

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/workspaces/${encodeURIComponent(workspaceApiRef(workspace))}/members`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { members: [] }))
      .then((body: { members?: Member[] }) => {
        if (!cancelled) setMembers((body.members ?? []).filter((m) => m.role !== "agent"));
      })
      .catch(() => {
        if (!cancelled) setMembers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspace]);

  const selected = new Set(escalation.notify_user_ids);
  const email = escalation.via.includes("email");

  const toggleMember = (userId: string, on: boolean) => {
    const ids = on ? [...selected, userId] : [...selected].filter((id) => id !== userId);
    void onUpdate({ escalation: { ...escalation, notify_user_ids: ids } });
  };

  return (
    <div className="flex flex-col gap-4">
      {members === null ? (
        <p className="m-0 text-[12.5px] text-muted">Loading the team…</p>
      ) : members.length === 0 ? (
        <p className="m-0 text-[12.5px] text-muted">Nobody to notify in this workspace yet.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {members.map((member) => (
            <li key={member.userId}>
              <Checkbox
                isSelected={selected.has(member.userId)}
                onChange={(on) => toggleMember(member.userId, on)}
                className="w-full rounded-lg px-2 py-1.5 hover:bg-[var(--paper-2)]"
              >
                <Checkbox.Content className="flex w-full items-center gap-2.5">
                  {/* The default control is a field-coloured square that vanishes on
                      the paper background; the border makes the unchecked state visible. */}
                  <Checkbox.Control className="border-[1.5px] !border-[var(--ink-mute)] bg-transparent">
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  <PersonAvatar user={{ id: member.userId, email: member.email }} size={24} />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-normal text-foreground">
                    {member.name ?? member.email ?? "Someone"}
                  </span>
                  {member.name && member.email ? (
                    <span className="hidden truncate text-[11.5px] font-normal text-muted sm:inline">{member.email}</span>
                  ) : null}
                </Checkbox.Content>
              </Checkbox>
            </li>
          ))}
        </ul>
      )}
      <SettingSwitch
        title="Also by email"
        description="One email per escalation to the people above."
        isSelected={email}
        onChange={(on) => void onUpdate({ escalation: { ...escalation, via: on ? ["inbox", "email"] : ["inbox"] } })}
      />
    </div>
  );
}

/**
 * Name, description and the prompt. The prompt is long and rarely changed,
 * so it starts folded, reads as rendered Markdown, and is edited on purpose.
 */
function Instructions({
  workspace,
  nexo,
  onUpdate,
  onReplace,
}: {
  workspace: WorkspaceAddress;
  nexo: NexoView;
  onUpdate: Update;
  onReplace: (next: Nexo) => void;
}) {
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState(nexo.prompt_md);
  const [pending, setPending] = useState(false);
  const [confirmRewrite, setConfirmRewrite] = useState(false);
  const [rewriting, setRewriting] = useState(false);

  useEffect(() => {
    if (!editing) setPrompt(nexo.prompt_md);
  }, [editing, nexo.prompt_md]);

  const dirty = prompt !== nexo.prompt_md;

  return (
    <div className="flex flex-col gap-4">
      <AutoSaveText
        label="Name"
        value={nexo.name}
        required
        hint={nexo.is_general ? undefined : "Its face comes from its name, so a new name is a new face."}
        onSave={(name) => onUpdate({ name })}
      />
      <AutoSaveText
        label="Description"
        value={nexo.description ?? ""}
        rows={2}
        placeholder="What the team should know it does, in a line."
        onSave={(description) => onUpdate({ description })}
      />

      <Disclosure isExpanded={expanded} onExpandedChange={setExpanded}>
        <Disclosure.Heading>
          <Button slot="trigger" variant="ghost" size="sm" className="-ml-2 gap-1.5 text-[13px] font-medium">
            What it follows on every run
            <Disclosure.Indicator />
          </Button>
        </Disclosure.Heading>
        <Disclosure.Content>
          <Disclosure.Body className="px-0 pt-2">
            {editing ? (
              <div className="flex flex-col gap-2">
                <TextQuestion label="Instructions, in Markdown" value={prompt} onChange={setPrompt} rows={16} mono />
                <div className="flex flex-wrap items-center gap-1.5">
                  {nexo.is_general ? null : (
                    <Button size="sm" variant="ghost" onPress={() => setConfirmRewrite(true)}>
                      Rewrite from its questionnaire
                    </Button>
                  )}
                  <span className="flex-1" />
                  <Button
                    size="sm"
                    variant="secondary"
                    onPress={() => {
                      setPrompt(nexo.prompt_md);
                      setEditing(false);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    isDisabled={!dirty || !prompt.trim()}
                    isPending={pending}
                    onPress={async () => {
                      setPending(true);
                      const ok = await onUpdate({ prompt_md: prompt }, "Instructions saved.");
                      setPending(false);
                      if (ok) setEditing(false);
                    }}
                  >
                    Save
                  </Button>
                </div>
              </div>
            ) : (
              <div className="rounded-[14px] border border-[var(--line)] bg-[var(--paper)] px-4 py-3">
                <NexoRichText markdown={nexo.prompt_md || "_No instructions yet._"} />
                <div className="mt-3 flex justify-end">
                  <Button size="sm" variant="outline" className="gap-1.5" onPress={() => setEditing(true)}>
                    <Pencil size={13} />
                    Edit
                  </Button>
                </div>
              </div>
            )}
          </Disclosure.Body>
        </Disclosure.Content>
      </Disclosure>

      <ConfirmDialog
        open={confirmRewrite}
        title="Rewrite the instructions?"
        body="Bcontext writes them again from the questionnaire. Any change you made by hand is replaced."
        confirmLabel="Rewrite"
        tone="danger"
        busy={rewriting}
        onCancel={() => setConfirmRewrite(false)}
        onConfirm={async () => {
          setRewriting(true);
          try {
            const next = await nexosApi.regeneratePrompt(workspace, nexo.id);
            setPrompt(next.prompt_md);
            onReplace(next);
            setEditing(false);
            toast.info("Instructions rewritten.");
          } catch (e) {
            toast.error(`Couldn't rewrite them: ${(e as Error).message}`);
          } finally {
            setRewriting(false);
            setConfirmRewrite(false);
          }
        }}
      />
    </div>
  );
}

function Budget({ nexo, onUpdate }: { nexo: NexoView; onUpdate: Update }) {
  const capped = nexo.monthly_budget_credits != null;
  // Remembered while the cap is off, so switching it back on restores it.
  const [amount, setAmount] = useState<number>(nexo.monthly_budget_credits ?? 500);

  return (
    <div className="flex flex-col gap-3">
      <SettingSwitch
        title="Cap its spending"
        description={
          capped
            ? "AI credits it may spend each calendar month, on top of the workspace's own limit."
            : "No cap of its own: it spends from the workspace's credit."
        }
        isSelected={capped}
        onChange={(on) => void onUpdate({ monthly_budget_credits: on ? amount : null })}
      />
      {capped ? (
        <NumberField
          aria-label="Monthly credits"
          className="w-[170px]"
          minValue={1}
          step={50}
          value={nexo.monthly_budget_credits ?? amount}
          // NumberField commits on blur, Enter and the steppers — never per keystroke.
          onChange={(next) => {
            if (!Number.isFinite(next) || next < 1 || next === nexo.monthly_budget_credits) return;
            setAmount(next);
            void onUpdate({ monthly_budget_credits: next });
          }}
        >
          <Label className="text-[12px] text-muted">Credits per month</Label>
          <NumberField.Group>
            <NumberField.DecrementButton />
            <NumberField.Input className="tabular-nums" />
            <NumberField.IncrementButton />
          </NumberField.Group>
        </NumberField>
      ) : null}
    </div>
  );
}

function DangerZone({ nexo, onUpdate, onDelete }: { nexo: NexoView; onUpdate: Update; onDelete: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const paused = nexo.status === "paused";

  return (
    <div className="flex flex-col divide-y divide-[var(--line)] rounded-[14px] border border-[var(--line)]">
      <Row
        title={paused ? `Resume ${nexo.name}` : `Pause ${nexo.name}`}
        body={paused ? "It listens and runs its routine again." : "It stops listening and stops its routine. You can still chat with it."}
        action={
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onPress={() =>
              void onUpdate({ status: paused ? "active" : "paused" }, paused ? `${nexo.name} is back at work.` : `${nexo.name} is paused.`)
            }
          >
            {paused ? <Play size={13} /> : <Pause size={13} />}
            {paused ? "Resume" : "Pause"}
          </Button>
        }
      />
      {nexo.is_general ? (
        <Row title="Delete" body="The general Nexo can be paused but not deleted: it hears whatever no specialist owns." />
      ) : (
        <Row
          title={`Delete ${nexo.name}`}
          body="Its sources go back to the general Nexo. What it wrote to the brain stays."
          action={
            <Button size="sm" variant="danger-soft" onPress={() => setOpen(true)}>
              Delete
            </Button>
          }
        />
      )}
      <ConfirmDialog
        open={open}
        title={`Delete ${nexo.name}?`}
        body="This cannot be undone. Its sources go back to the general Nexo."
        confirmLabel="Delete"
        tone="danger"
        busy={busy}
        onCancel={() => setOpen(false)}
        onConfirm={async () => {
          setBusy(true);
          await onDelete();
          setBusy(false);
          setOpen(false);
        }}
      />
    </div>
  );
}

function Row({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
      <div className="min-w-0 flex-1 basis-[240px]">
        <p className="m-0 text-[13px] font-medium text-foreground">{title}</p>
        <p className="m-0 mt-0.5 text-[12px] leading-[1.5] text-muted">{body}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
