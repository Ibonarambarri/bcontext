"use client";

/**
 * The form controls the Nexo wizard and the Nexo's Setup tab share, so a
 * question is asked the same way when it is first answered and when it is
 * changed later. Presentational only: value in, change out — except
 * `AutoSaveText`, which owns the draft between keystrokes and the save.
 *
 * Setup saves per control (no form-wide Save): switches and choices apply on
 * press through the caller's optimistic update; text applies on blur or with
 * the small Save that appears only while it differs from what is saved.
 */
import { useEffect, useRef, useState } from "react";
import { Button, Description, Input, Label, Switch, TextArea, TextField } from "@heroui/react";
import { CheckboxButtonGroup, RadioButtonGroup } from "@/components/ui/button-groups";
import { NEXO_CAN_DO, NEXO_TONES, type NexoAutonomy, type NexoCanDo, type NexoTone } from "@bcontext-dev/contract/nexos";
import { AUTONOMY_COPY, AUTONOMY_ORDER, canDoLabel, toneLabel } from "./nexo-copy";

export function TextQuestion({
  label,
  hint,
  value,
  onChange,
  placeholder,
  rows,
  autoFocus,
  isDisabled,
  mono,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Multi-line when set. */
  rows?: number;
  autoFocus?: boolean;
  isDisabled?: boolean;
  mono?: boolean;
}) {
  return (
    <TextField value={value} onChange={onChange} isDisabled={isDisabled} fullWidth>
      <Label>{label}</Label>
      {rows ? (
        <TextArea
          rows={rows}
          placeholder={placeholder}
          autoFocus={autoFocus}
          variant="secondary"
          className={mono ? "mono text-[12px] leading-[1.6]" : "text-[13px] leading-[1.55]"}
        />
      ) : (
        <Input placeholder={placeholder} autoFocus={autoFocus} variant="secondary" />
      )}
      {hint ? <Description className="text-[11.5px]">{hint}</Description> : null}
    </TextField>
  );
}

export function CanDoPicker({
  value,
  onChange,
}: {
  value: NexoCanDo[];
  onChange: (value: NexoCanDo[]) => void;
}) {
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0">
      <legend className="mb-2 text-[13px] font-medium text-foreground">What can it do without asking?</legend>
      <CheckboxButtonGroup
        aria-label="What it can do without asking"
        value={value}
        onChange={(next) => onChange(next as NexoCanDo[])}
        className="flex flex-wrap gap-1.5"
      >
        {NEXO_CAN_DO.map((key) => (
          <CheckboxButtonGroup.Item key={key} value={key} className="rounded-lg px-3 py-2">
            <CheckboxButtonGroup.Indicator />
            <CheckboxButtonGroup.ItemContent>
              <span className="text-[12.5px]">{canDoLabel(key)}</span>
            </CheckboxButtonGroup.ItemContent>
          </CheckboxButtonGroup.Item>
        ))}
      </CheckboxButtonGroup>
    </fieldset>
  );
}

export function TonePicker({ value, onChange }: { value: NexoTone; onChange: (value: NexoTone) => void }) {
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0">
      <legend className="mb-2 text-[13px] font-medium text-foreground">Tone</legend>
      <RadioButtonGroup
        aria-label="Tone"
        value={value}
        onChange={(next) => onChange(next as NexoTone)}
        orientation="horizontal"
        className="flex flex-wrap gap-1.5"
      >
        {NEXO_TONES.map((tone) => (
          <RadioButtonGroup.Item key={tone} value={tone} className="rounded-lg px-3 py-2">
            <RadioButtonGroup.Indicator />
            <RadioButtonGroup.ItemContent>
              <span className="text-[12.5px]">{toneLabel(tone)}</span>
            </RadioButtonGroup.ItemContent>
          </RadioButtonGroup.Item>
        ))}
      </RadioButtonGroup>
    </fieldset>
  );
}

/**
 * Autonomy as three cards, each saying in one sentence what the Nexo will
 * and will not do — the choice is about trust, and trust is not granted to a
 * label.
 */
export function AutonomyPicker({
  value,
  onChange,
  isDisabled,
}: {
  value: NexoAutonomy;
  onChange: (value: NexoAutonomy) => void;
  isDisabled?: boolean;
}) {
  return (
    <RadioButtonGroup
      aria-label="Autonomy"
      value={value}
      onChange={(next) => onChange(next as NexoAutonomy)}
      isDisabled={isDisabled}
      layout="grid"
      className="grid grid-cols-1 gap-2 sm:grid-cols-3"
    >
      {AUTONOMY_ORDER.map((key) => (
        <RadioButtonGroup.Item key={key} value={key} className="items-start rounded-xl p-3">
          <RadioButtonGroup.Indicator />
          <RadioButtonGroup.ItemContent className="gap-1">
            <span className="text-[13px] font-medium text-foreground">{AUTONOMY_COPY[key].label}</span>
            <span className="text-[11.5px] leading-[1.5] text-muted">{AUTONOMY_COPY[key].what}</span>
          </RadioButtonGroup.ItemContent>
        </RadioButtonGroup.Item>
      ))}
    </RadioButtonGroup>
  );
}

/**
 * One on/off setting as a single row: title and line of explanation on the
 * left, the switch at the trailing end, and the whole row is the switch's
 * label — the words are as pressable as the track. Keeping the text inside
 * `Switch.Content` is the point: text beside the switch, outside its label,
 * reads as clickable and does nothing.
 */
export function SettingSwitch({
  title,
  description,
  icon,
  isSelected,
  isDisabled,
  onChange,
}: {
  title: string;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  isSelected: boolean;
  isDisabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <Switch aria-label={title} isSelected={isSelected} isDisabled={isDisabled} onChange={onChange} className="w-full">
      <Switch.Content className="flex w-full items-start gap-3 font-normal">
        {icon ? (
          <span aria-hidden="true" className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--paper-2)] text-[var(--ink-2)]">
            {icon}
          </span>
        ) : null}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[13px] font-medium text-foreground">{title}</span>
          {description ? <span className="mt-0.5 text-[12px] leading-[1.5] text-muted">{description}</span> : null}
        </span>
        <Switch.Control className="mt-0.5 shrink-0">
          <Switch.Thumb />
        </Switch.Control>
      </Switch.Content>
    </Switch>
  );
}

/**
 * A text setting that saves itself: on blur when it changed, or with the
 * Save that shows only while there is something to save (a long text is
 * not always left by blurring it). Enter saves a one-line field. Follows the
 * saved value when it changes underneath and the person is not editing.
 */
export function AutoSaveText({
  label,
  hint,
  value,
  onSave,
  rows,
  placeholder,
  required,
  mono,
}: {
  label: string;
  hint?: string;
  value: string;
  /** Resolves false when the save was refused (the caller already said why). */
  onSave: (value: string) => Promise<boolean>;
  rows?: number;
  placeholder?: string;
  /** An empty value is put back instead of saved. */
  required?: boolean;
  mono?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [pending, setPending] = useState(false);
  const editing = useRef(false);

  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);

  const dirty = draft.trim() !== value.trim();

  const commit = async () => {
    editing.current = false;
    if (!dirty || pending) return;
    if (required && !draft.trim()) {
      setDraft(value);
      return;
    }
    setPending(true);
    const ok = await onSave(draft.trim());
    setPending(false);
    if (!ok) setDraft(value);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <TextField
        value={draft}
        onChange={(next) => {
          editing.current = true;
          setDraft(next);
        }}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (!rows && e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        fullWidth
      >
        <Label>{label}</Label>
        {rows ? (
          <TextArea
            rows={rows}
            placeholder={placeholder}
            variant="secondary"
            className={mono ? "mono text-[12px] leading-[1.6]" : "text-[13px] leading-[1.55]"}
          />
        ) : (
          <Input placeholder={placeholder} variant="secondary" />
        )}
        {hint ? <Description className="text-[11.5px]">{hint}</Description> : null}
      </TextField>
      {dirty && rows ? (
        <div className="flex justify-end">
          <Button size="sm" variant="secondary" isPending={pending} onPress={() => void commit()}>
            Save
          </Button>
        </div>
      ) : null}
    </div>
  );
}
