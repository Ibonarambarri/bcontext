"use client";

/**
 * What happens to this problem, and what was learned about it.
 *
 * The four states are one control rather than a select: there are four of them, they are the whole vocabulary, and a
 * press is one act instead of open-pick-close. The current one is the pressed
 * one and cannot be pressed again — re-filing a problem as what it already is
 * is a write that says nothing.
 *
 * The note sits under them behind a Save because it is prose: saving on every
 * keystroke would write a hundred half-sentences, and saving on blur loses
 * the one that was still being typed when the tab changed.
 */

import { useActionState, useEffect, useState } from "react";
import { Button, ButtonGroup, TextArea } from "@heroui/react";
import {
  ERROR_STATUSES,
  ERROR_STATUS_LABELS,
  type ErrorStatus,
} from "@bcontext-dev/contract/errors";
import {
  saveErrorNoteAction,
  setErrorStatusAction,
  type ErrorNoteState,
  type ErrorStatusState,
} from "./actions";

export function TriageControls({
  id,
  status,
  note,
}: {
  id: string;
  status: ErrorStatus;
  note: string | null;
}) {
  return (
    <div className="flex flex-col gap-3">
      <StatusControl id={id} status={status} />
      <NoteBox id={id} note={note} />
    </div>
  );
}

function StatusControl({ id, status }: { id: string; status: ErrorStatus }) {
  const [state, setStatus, pending] = useActionState<
    ErrorStatusState,
    FormData
  >(setErrorStatusAction, {});

  // The server's answer wins over the press: a refusal has to be visible in
  // the control itself, not only in the line of red under it.
  const current = state.saved ?? status;

  return (
    <form action={setStatus}>
      <input type="hidden" name="id" value={id} />
      <ButtonGroup size="sm">
        {ERROR_STATUSES.map((s) => (
          <Button
            key={s}
            type="submit"
            name="status"
            value={s}
            variant={s === current ? "primary" : "secondary"}
            isDisabled={s === current || pending}
          >
            {ERROR_STATUS_LABELS[s]}
          </Button>
        ))}
      </ButtonGroup>

      {state.error ? (
        <p
          role="alert"
          className="mt-1 text-[11.5px] text-[var(--danger,#dc2626)]"
        >
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

/**
 * The one thing the telemetry cannot record: what a person found out.
 *
 * A group that reopens keeps its note, which is the point — "this is the
 * retry storm from the connector, it is upstream" is worth more the second
 * time it fires than the first.
 */
function NoteBox({ id, note }: { id: string; note: string | null }) {
  const [state, save, pending] = useActionState<ErrorNoteState, FormData>(
    saveErrorNoteAction,
    {},
  );
  const [draft, setDraft] = useState(note ?? "");
  const saved = state.saved ?? note ?? "";
  const dirty = draft !== saved;

  // Whatever the API confirmed is what the box shows: a note the server
  // trimmed or refused should not keep being displayed as if it had landed.
  useEffect(() => {
    if (state.saved !== undefined) setDraft(state.saved);
  }, [state.saved]);

  return (
    <form action={save} className="flex flex-col gap-1.5">
      <input type="hidden" name="id" value={id} />
      <TextArea
        name="note"
        aria-label="What is known about this problem"
        variant="secondary"
        rows={2}
        fullWidth
        placeholder="What is known about this — the cause, the ticket, why it is being ignored."
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        className="text-[12.5px]"
      />
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          isDisabled={!dirty || pending}
        >
          {pending ? "Saving…" : "Save note"}
        </Button>
        {dirty && !pending ? (
          <span className="text-[11px] text-[var(--ink-mute)]">unsaved</span>
        ) : null}
      </div>

      {state.error ? (
        <p role="alert" className="text-[11.5px] text-[var(--danger,#dc2626)]">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
