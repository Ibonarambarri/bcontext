"use client";

/**
 * Rendering surface for `kind === "goal"` nodes — the same idea as
 * `credential-node-view.tsx`: a kind whose meaning lives in `data`, drawn
 * from the contract's shape instead of from prose.
 *
 * A goal is NOT a task with a different label, and this is where that shows:
 *
 *   - Its state is health (`on_track … abandoned`), not progress through a
 *     queue. It shares the `status` column with tasks, so every label goes
 *     through `statusLabel()` and nothing here assumes which vocabulary a
 *     node's status belongs to.
 *   - Its progress is COMPUTED from the key results (`goalProgress`), never
 *     declared. When nothing is measurable that is "—", not 0%.
 *   - Its scope (`company` / `project`, plus the workspace's single
 *     `root` North Star) is read straight off `data`. It is decided at
 *     creation and persisted; re-deriving it here from tags or edges would
 *     let an unrelated cleanup silently demote a company goal.
 *   - Its horizon ends in the node's own `due_date` column and starts in
 *     `data.timeframe.start`; the cycle (`2027-Q1`) is a derived label.
 *
 * Unlike a credential, a goal still has a body worth writing — the why, the
 * bets, the review notes — so this panel sits ABOVE the editor rather than
 * replacing it (`lazy-node-body.tsx` on the page, `node-panel/goal-body.tsx`
 * in the floating panel). Every write here — a health change, a key
 * result's current value, a key result added or removed — is optimistic:
 * the control moves, then `PATCH /api/nodes/:id` with `if_updated_at` runs
 * behind it, reverted with a toast if the API refuses, re-read on a 409.
 * Key results live in `data.key_results`, and `data` is written whole, so
 * the write spreads the freshest `data` this component holds and only
 * replaces that key. `onWritten` hands each confirmed node back to a parent
 * that keeps its own copy (the floating panel).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Chip, ListBox, Meter, Select } from "@heroui/react";
import { ArrowDownRight, ArrowUpRight, Minus, Plus, Target, Trash2, X } from "lucide-react";
import {
  goalData,
  goalProgress,
  keyResultProgress,
  type GoalData,
  type KeyResult,
  type KeyResultDirection,
} from "@bcontext-dev/contract/goals";
import {
  isGoalStatus,
  statusLabel,
  type GoalStatus,
  type KnowledgeNode,
} from "@bcontext-dev/contract/types";
import { cn } from "@bcontext-dev/contract/utils";
import {
  GOAL_STATUSES,
  GOAL_STATUS_DOT,
  formatGoalProgress,
  goalHorizon,
  goalHorizonRemaining,
  goalScopeLabel,
  keyResultTargetLabel,
  formatKeyResultValue,
} from "@/lib/goals/presentation";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useWorkspace } from "@/components/workspace-context";
import { newestUpdatedAt } from "@/lib/newest-updated-at";
import { workspaceApiRef } from "@/web/workspace-url";

const DIRECTION_ICON = {
  increase: ArrowUpRight,
  decrease: ArrowDownRight,
  maintain: Minus,
} as const;

/** The health dot + label, in whichever vocabulary this node's status is written in. */
function HealthChip({ status }: { status: KnowledgeNode["status"] }) {
  if (!status) return null;
  return (
    <Chip size="sm" variant="soft" className="shrink-0 gap-1 text-[10px]">
      <span
        aria-hidden
        className="size-1.5 rounded-full"
        style={{ background: isGoalStatus(status) ? GOAL_STATUS_DOT[status] : "var(--ink-mute)" }}
      />
      <Chip.Label>{statusLabel(status)}</Chip.Label>
    </Chip>
  );
}

/**
 * The guarded writer every editable control here shares. Optimistic per the
 * product convention: the caller changes its value first, `save` runs the
 * PATCH behind it and calls `revert` if the API refuses. The write is
 * guarded by `if_updated_at` — the freshest value this client knows: the
 * workspace overlay (confirmed writes, the editor's saves and peers'
 * broadcasts all fold into it) or the node as rendered, whichever is newer
 * — so a 409 means someone else really wrote first: revert, re-read the
 * node and show what is stored instead of overwriting it.
 */
function useGoalWriter(node: KnowledgeNode, onWritten?: (node: KnowledgeNode) => void) {
  const { address, nodes, patchNodeSummary, toast } = useWorkspace();
  const [saving, setSaving] = useState(false);
  const [seenUpdatedAt, setSeenUpdatedAt] = useState<string | undefined>(undefined);
  const updatedAt = newestUpdatedAt(
    nodes.find((candidate) => candidate.id === node.id)?.updated_at,
    node.updated_at,
    seenUpdatedAt,
  );

  const fold = useCallback((current: KnowledgeNode) => {
    setSeenUpdatedAt(current.updated_at);
    patchNodeSummary(node.id, { status: current.status, data: current.data, updated_at: current.updated_at });
    onWritten?.(current);
  }, [node.id, patchNodeSummary, onWritten]);

  const reload = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/nodes/${encodeURIComponent(node.id)}?workspace=${encodeURIComponent(workspaceApiRef(address))}`,
        { cache: "no-store" },
      );
      if (!response.ok) return;
      const body = (await response.json()) as { node?: KnowledgeNode };
      if (body.node) fold(body.node);
    } catch {
      // The toast already said the goal moved on; a failed re-read just
      // means the next save 409s again, which is the safe outcome.
    }
  }, [node.id, address, fold]);

  const save = useCallback(async (
    patch: Partial<Pick<KnowledgeNode, "status" | "data">>,
    revert: () => void,
    failMessage: string,
  ): Promise<boolean> => {
    setSaving(true);
    try {
      const response = await fetch(`/api/nodes/${encodeURIComponent(node.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace: workspaceApiRef(address),
          ...(updatedAt ? { if_updated_at: updatedAt } : {}),
          ...patch,
        }),
      });
      if (response.status === 409) {
        revert();
        await reload();
        toast.error("This goal changed elsewhere. Showing the stored version — try again.");
        return false;
      }
      if (!response.ok) throw new Error("save failed");
      const body = (await response.json()) as { node?: KnowledgeNode };
      if (body.node) fold(body.node);
      return true;
    } catch {
      revert();
      toast.error(failMessage);
      return false;
    } finally {
      setSaving(false);
    }
  }, [node.id, address, updatedAt, reload, fold, toast]);

  return { save, saving };
}

type GoalWriter = ReturnType<typeof useGoalWriter>;

/** Health, editable in place; the value moves first and the write follows. */
function HealthSelect({ node, writer }: { node: KnowledgeNode; writer: GoalWriter }) {
  const initial: GoalStatus = isGoalStatus(node.status) ? node.status : "on_track";
  const [status, setStatus] = useState<GoalStatus>(initial);
  useEffect(() => {
    if (isGoalStatus(node.status)) setStatus(node.status);
  }, [node.status]);

  function change(next: GoalStatus) {
    const previous = status;
    setStatus(next);
    void writer.save({ status: next }, () => setStatus(previous), "Couldn’t save the goal’s health. It was reverted.");
  }

  return (
    <Select
      aria-label="Goal health"
      isDisabled={writer.saving}
      value={status}
      onChange={(key) => {
        if (key != null && key !== status) change(String(key) as GoalStatus);
      }}
    >
      <Select.Trigger className="inline-flex items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--paper)] px-2 py-0.5 text-[11px] text-[var(--ink-2)] hover:border-[var(--line-strong)]">
        <span aria-hidden className="size-1.5 rounded-full" style={{ background: GOAL_STATUS_DOT[status] }} />
        <Select.Value className="text-[11px]" />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {GOAL_STATUSES.map((value) => (
            <ListBox.Item key={value} id={value} textValue={statusLabel(value)}>
              {statusLabel(value)}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

const DIRECTION_LABEL: Record<KeyResultDirection, string> = {
  increase: "Increase to",
  decrease: "Decrease to",
  maintain: "Keep at or above",
};

const FIELD_CLASS =
  "rounded-md border border-[var(--line)] bg-[var(--paper)] px-2 py-1 text-[12px] text-[var(--ink)] outline-none placeholder:text-[var(--ink-mute)] focus:border-[var(--line-strong)] disabled:opacity-60";

/**
 * Inline number for a key result's `current`: the value that changes most
 * often, so it is the one edited in place. Enter or blur commits; Escape
 * puts the stored value back.
 */
function CurrentValueInput({
  kr,
  disabled,
  onCommit,
}: {
  kr: KeyResult;
  disabled: boolean;
  onCommit: (value: number) => void;
}) {
  const stored = kr.current;
  const [draft, setDraft] = useState(String(stored));
  useEffect(() => setDraft(String(stored)), [stored]);
  const commit = () => {
    const value = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(value)) {
      setDraft(String(kr.current));
      return;
    }
    if (value !== kr.current) onCommit(value);
  };
  return (
    <input
      type="number"
      inputMode="decimal"
      step="any"
      value={draft}
      disabled={disabled}
      aria-label={`${kr.name} current value`}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") { setDraft(String(kr.current)); event.currentTarget.blur(); }
      }}
      className={cn(FIELD_CLASS, "w-[72px] shrink-0 text-right tabular-nums")}
    />
  );
}

/** Name, direction, baseline, target and current — enough to compute progress. */
function KeyResultDraftForm({
  busy,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  onSubmit: (kr: Omit<KeyResult, "id">) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("");
  const [direction, setDirection] = useState<KeyResultDirection>("increase");
  const [baseline, setBaseline] = useState("0");
  const [target, setTarget] = useState("");
  const [current, setCurrent] = useState("");
  const numbers = { baseline: Number(baseline), target: Number(target), current: Number(current === "" ? baseline : current) };
  const valid =
    name.trim().length > 0 &&
    target.trim() !== "" &&
    Object.values(numbers).every((value) => Number.isFinite(value));
  const submit = () => {
    if (!valid || busy) return;
    void onSubmit({ name: name.trim(), unit: unit.trim() || null, direction, ...numbers });
  };
  return (
    <form
      className="mt-2 flex flex-col gap-1.5 rounded-md border border-[var(--line)] bg-[var(--paper)] p-2.5"
      data-testid="key-result-draft"
      onSubmit={(event) => { event.preventDefault(); submit(); }}
      onKeyDown={(event) => { if (event.key === "Escape") onCancel(); }}
    >
      <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="What does this measure?" aria-label="Key result name" className={FIELD_CLASS} />
      <div className="flex flex-wrap items-center gap-1.5">
        <select value={direction} onChange={(event) => setDirection(event.target.value as KeyResultDirection)} aria-label="Direction" className={cn(FIELD_CLASS, "h-7")}>
          {(Object.keys(DIRECTION_LABEL) as KeyResultDirection[]).map((value) => (
            <option key={value} value={value}>{DIRECTION_LABEL[value]}</option>
          ))}
        </select>
        <input type="number" step="any" value={target} onChange={(event) => setTarget(event.target.value)} placeholder="Target" aria-label="Target" className={cn(FIELD_CLASS, "w-[84px] tabular-nums")} />
        <input value={unit} onChange={(event) => setUnit(event.target.value)} placeholder="Unit" aria-label="Unit" className={cn(FIELD_CLASS, "w-[64px]")} />
        <input type="number" step="any" value={baseline} onChange={(event) => setBaseline(event.target.value)} placeholder="Baseline" aria-label="Baseline" className={cn(FIELD_CLASS, "w-[84px] tabular-nums")} />
        <input type="number" step="any" value={current} onChange={(event) => setCurrent(event.target.value)} placeholder="Current" aria-label="Current" className={cn(FIELD_CLASS, "w-[84px] tabular-nums")} />
      </div>
      <div className="flex items-center justify-end gap-1.5">
        <Button size="sm" variant="ghost" isDisabled={busy} onPress={onCancel} className="h-7 gap-1 text-[11.5px]">
          <X size={11} /> Cancel
        </Button>
        <Button size="sm" variant="primary" isDisabled={!valid || busy} type="submit" className="h-7 gap-1 text-[11.5px]">
          <Plus size={11} /> Add key result
        </Button>
      </div>
    </form>
  );
}

/** Short ids, unique within the goal; agents address key results by them. */
function newKeyResultId(existing: readonly KeyResult[]): string {
  const taken = new Set(existing.map((kr) => kr.id));
  for (let attempt = 0; attempt < 50; attempt++) {
    const id = `kr-${Math.random().toString(36).slice(2, 8)}`;
    if (!taken.has(id)) return id;
  }
  return `kr-${existing.length + 1}-${Date.now().toString(36)}`;
}

/** One key result: what it measures, where it is, and how far that is. */
function KeyResultRow({
  kr,
  editable,
  saving,
  onCurrent,
  onRemove,
}: {
  kr: KeyResult;
  editable: boolean;
  saving: boolean;
  onCurrent: (value: number) => void;
  onRemove: () => void;
}) {
  const progress = keyResultProgress(kr);
  const Direction = DIRECTION_ICON[kr.direction] ?? Minus;
  return (
    <li className="group flex flex-col gap-1 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2.5 py-2">
      <div className="flex items-center gap-2">
        <Direction size={11} aria-hidden className="shrink-0 text-[var(--ink-mute)]" />
        <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--ink)]">{kr.name}</span>
        {editable ? (
          <CurrentValueInput kr={kr} disabled={saving} onCommit={onCurrent} />
        ) : (
          <span className="shrink-0 text-[11.5px] tabular-nums text-[var(--ink-2)]">
            {formatKeyResultValue(kr.current, kr.unit)}
          </span>
        )}
        <span className="shrink-0 text-[11px] tabular-nums text-[var(--ink-mute)]">
          {formatGoalProgress(progress)}
        </span>
        {editable ? (
          <button
            type="button"
            disabled={saving}
            onClick={onRemove}
            aria-label={`Remove key result ${kr.name}`}
            className="-mr-1 shrink-0 rounded-md p-1 text-[var(--ink-mute)] opacity-0 transition-opacity hover:bg-[var(--paper-3)] hover:text-[var(--ink)] focus-visible:opacity-100 group-hover:opacity-100 motion-reduce:transition-none"
          >
            <Trash2 size={11} />
          </button>
        ) : null}
      </div>
      <div className="flex items-center gap-2 pl-[19px]">
        {/* No bar when there is nothing to measure: an empty track reads as
            "0% done", which is a different claim from "unmeasurable". */}
        {progress === null ? (
          <span className="min-w-0 flex-1 text-[10px] text-[var(--ink-mute)]">Nothing to measure yet</span>
        ) : (
          <Meter
            size="sm"
            aria-label={`${kr.name} progress`}
            value={Math.round(progress * 100)}
            maxValue={100}
            className="min-w-0 flex-1"
          >
            <Meter.Track>
              <Meter.Fill />
            </Meter.Track>
          </Meter>
        )}
        <span className="shrink-0 text-[10px] tabular-nums text-[var(--ink-mute)]">
          {keyResultTargetLabel(kr)}
        </span>
      </div>
    </li>
  );
}

export function GoalOverview({
  node,
  editable = false,
  showHealth = true,
  onWritten,
  className,
}: {
  node: KnowledgeNode;
  /** Let the person change health and key results here. */
  editable?: boolean;
  /** Off where another control already owns the status (the panel's strip). */
  showHealth?: boolean;
  /** Each confirmed write's node, for a parent that keeps its own copy. */
  onWritten?: (node: KnowledgeNode) => void;
  className?: string;
}) {
  const writer = useGoalWriter(node, onWritten);
  // The node is the source of truth (the page re-renders, the panel
  // reloads); take its data whenever a NEWER version arrives and nothing of
  // ours is mid-flight, so a peer's update shows up without clobbering our
  // own. Keyed on `updated_at`, not identity: on the page the prop stays the
  // server render after a save, and re-reading it would undo the write.
  const [data, setData] = useState<GoalData>(() => goalData(node));
  const syncedRef = useRef(node.updated_at);
  useEffect(() => {
    if (writer.saving || node.updated_at === syncedRef.current) return;
    syncedRef.current = node.updated_at;
    setData(goalData(node));
  }, [node, writer.saving]);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const keyResults = data.key_results ?? [];
  const removingKr = removing ? keyResults.find((kr) => kr.id === removing) ?? null : null;
  const progress = goalProgress(keyResults);

  /** Write `data` whole with only `key_results` replaced; revert to what was shown. */
  const writeKeyResults = (next: KeyResult[], failMessage: string) => {
    const previous = data;
    const nextData: GoalData = { ...data, key_results: next };
    setData(nextData);
    return writer.save(
      { data: nextData as Record<string, unknown> },
      () => setData(previous),
      failMessage,
    );
  };
  const horizon = goalHorizon(data, node.due_date);
  const remaining = goalHorizonRemaining(horizon.end);
  const scope = goalScopeLabel(data);

  return (
    <section
      aria-label="Goal"
      className={cn("rounded-xl border border-[var(--line)] bg-[var(--paper-2)] p-3", className)}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Target size={14} aria-hidden className="shrink-0 text-[var(--ink-3)]" />
        {scope ? (
          <Chip size="sm" variant="soft" className="shrink-0 text-[10px] text-[var(--ink-2)]">
            <Chip.Label>{scope}</Chip.Label>
          </Chip>
        ) : null}
        {!showHealth ? null : editable ? <HealthSelect node={node} writer={writer} /> : <HealthChip status={node.status} />}
        <span className="ml-auto text-[18px] leading-none tabular-nums text-[var(--ink)]">
          {formatGoalProgress(progress)}
        </span>
      </div>

      {/* The horizon: the cycle is the headline when the dates earned one,
          and the dates stay underneath because they are what is true. */}
      {horizon.label ? (
        <p className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11.5px] text-[var(--ink-3)]">
          <span className="text-[var(--ink-2)]">{horizon.label}</span>
          {horizon.cycle && horizon.range ? <span>{horizon.range}</span> : null}
          {remaining ? <span className="text-[var(--ink-mute)]">· {remaining}</span> : null}
        </p>
      ) : null}

      {progress !== null ? (
        <Meter
          size="sm"
          className="mt-2"
          aria-label="Goal progress across its key results"
          value={Math.round(progress * 100)}
          maxValue={100}
        >
          <Meter.Track>
            <Meter.Fill />
          </Meter.Track>
        </Meter>
      ) : null}

      <div className="mb-1.5 mt-4 flex items-center gap-2">
        <h2 className="mono text-[10px] uppercase tracking-[0.08em] text-[var(--ink-mute)]">
          Key results
        </h2>
        {editable && !adding ? (
          <Button
            size="sm"
            variant="ghost"
            isDisabled={writer.saving}
            onPress={() => setAdding(true)}
            className="ml-auto h-6 gap-1 rounded-md px-1.5 text-[11px] text-[var(--ink-2)]"
          >
            <Plus size={11} /> Add
          </Button>
        ) : null}
      </div>
      {keyResults.length === 0 && !adding ? (
        <p className="text-[11.5px] leading-relaxed text-[var(--ink-mute)]">
          No key results yet. Progress stays “—” until this goal says what it measures
          {editable ? " — add one here, or an agent writes them into " : " — an agent writes them into "}
          <span className="mono">data.key_results</span>.
        </p>
      ) : keyResults.length === 0 ? null : (
        <ul className="flex list-none flex-col gap-1.5 p-0">
          {keyResults.map((kr, index) => (
            <KeyResultRow
              key={kr.id || `kr-${index}`}
              kr={kr}
              editable={editable}
              saving={writer.saving}
              onCurrent={(value) => void writeKeyResults(
                keyResults.map((item) => (item === kr ? { ...item, current: value } : item)),
                "Couldn’t save the key result. It was reverted.",
              )}
              onRemove={() => setRemoving(kr.id || `kr-${index}`)}
            />
          ))}
        </ul>
      )}
      {adding ? (
        <KeyResultDraftForm
          busy={writer.saving}
          onCancel={() => setAdding(false)}
          onSubmit={async (draft) => {
            const ok = await writeKeyResults(
              [...keyResults, { id: newKeyResultId(keyResults), ...draft }],
              "Couldn’t add the key result.",
            );
            if (ok) setAdding(false);
            return ok;
          }}
        />
      ) : null}
      <ConfirmDialog
        open={removing !== null && removingKr !== null}
        title="Remove this key result?"
        body={
          removingKr ? (
            <>
              <span className="text-[var(--ink)]">{removingKr.name}</span>
              {" stops counting toward this goal’s progress, for everyone. This cannot be undone."}
            </>
          ) : null
        }
        confirmLabel="Remove"
        icon={<Trash2 size={15} />}
        busy={writer.saving}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const id = removing;
          setRemoving(null);
          if (!id) return;
          void writeKeyResults(
            keyResults.filter((kr, index) => (kr.id || `kr-${index}`) !== id),
            "Couldn’t remove the key result. It was put back.",
          );
        }}
      />

      {data.review_every ? (
        <p className="mt-3 text-[10.5px] text-[var(--ink-mute)]">
          Reviewed {data.review_every}
          {data.last_reviewed_at ? ` · last on ${data.last_reviewed_at.slice(0, 10)}` : ""}
        </p>
      ) : null}
    </section>
  );
}
