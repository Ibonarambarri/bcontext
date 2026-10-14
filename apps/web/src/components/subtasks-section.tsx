"use client";

/**
 * A task's subtasks, as the person sees them: one row per step — title,
 * the summary its author wrote, a checkbox top-right — and, when a row is
 * opened, the step's full content in place of the list. Shared by the node
 * panel (board, graph, search all open nodes there) and the `/n/<id>` page.
 *
 * Subtasks are not nodes: they live on `node.data.subtasks` and every write
 * goes through `POST /api/nodes/:id/subtasks` with the same op vocabulary
 * agents use over MCP (`add`, `toggle`, `delete` here). Toggling and
 * removing ask first — a subtask flipping by an accidental click is a false
 * signal to every agent reading progress, and a removed step is gone for
 * everyone — and are then optimistic: the list changes, the request runs,
 * a failure reverts it with a toast. A 409 (someone else wrote first) is
 * surfaced, never hidden, and the parent is asked to reload.
 */

import { ArrowLeft, CheckSquare, ChevronRight, ListChecks, Plus, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, Checkbox } from "@heroui/react";
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import {
  SUBTASK_LIMITS,
  readSubtasks,
  subtaskProgress,
  type Subtask,
  type SubtaskOp,
} from "@bcontext-dev/contract/subtasks";
import { cn } from "@bcontext-dev/contract/utils";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { NodeMarkdown } from "@/components/node-markdown";
import { useToast } from "@/components/workspace-context";
import { workspaceApiRef, type WorkspaceAddress } from "@/web/workspace-url";

interface WriteResponse {
  node: KnowledgeNode;
  changed: boolean;
  subtasks: Subtask[];
}

export function SubtasksSection({
  workspace,
  node,
  canWrite,
  onWritten,
  onConflict,
  onOpenNode,
  children,
  className,
}: {
  workspace: WorkspaceAddress;
  /** The task. `data.subtasks` and `updated_at` are what this reads. */
  node: Pick<KnowledgeNode, "id" | "kind" | "data" | "updated_at">;
  canWrite: boolean;
  /** The server's node after a successful write — fold it into your state. */
  onWritten?: (node: KnowledgeNode) => void;
  /** Someone else wrote first; the caller should reload the node. */
  onConflict?: () => void;
  onOpenNode?: (id: string, blockId: string | null) => void;
  /** The task's own body. Shown under the list; hidden while a step is open. */
  children?: ReactNode;
  className?: string;
}) {
  const toast = useToast();
  const fromNode = useMemo(() => readSubtasks(node.data), [node.data]);
  const [subtasks, setSubtasks] = useState<Subtask[]>(fromNode);
  const [updatedAt, setUpdatedAt] = useState(node.updated_at);
  const [openId, setOpenId] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: string; done: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);

  // The node is the source of truth (the panel reloads it on realtime
  // events); take its list whenever it changes and nothing of ours is
  // mid-flight, so a peer's toggle shows up without clobbering our own.
  useEffect(() => {
    if (inFlight.current) return;
    setSubtasks(fromNode);
    setUpdatedAt(node.updated_at);
  }, [fromNode, node.updated_at]);

  const progress = subtaskProgress(subtasks);
  const open = openId ? subtasks.find((s) => s.id === openId) ?? null : null;
  const openIndex = open ? subtasks.findIndex((s) => s.id === open.id) : -1;

  /**
   * One guarded write: the optimistic list is shown at once, the op goes to
   * the API with the freshest `updated_at` this section knows, and the
   * server's list replaces the guess. `revertMessage` is the toast a failure
   * shows; a 409 has its own wording and hands the reload to the parent.
   */
  const run = useCallback(async (op: SubtaskOp, optimistic: Subtask[], revertMessage: string) => {
    const previous = subtasks;
    setSubtasks(optimistic);
    setSaving(true);
    inFlight.current = true;
    try {
      const response = await fetch(`/api/nodes/${encodeURIComponent(node.id)}/subtasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace: workspaceApiRef(workspace), if_updated_at: updatedAt, ...op }),
      });
      if (response.status === 409) {
        setSubtasks(previous);
        toast.error("This task changed elsewhere. Reloaded — check the steps and try again.");
        onConflict?.();
        return false;
      }
      if (response.status === 401 || response.status === 403) {
        setSubtasks(previous);
        toast.error("You no longer have permission to edit this task.");
        return false;
      }
      if (!response.ok) throw new Error(`subtask ${op.op} failed`);
      const body = (await response.json()) as WriteResponse;
      setSubtasks(body.subtasks);
      setUpdatedAt(body.node.updated_at);
      onWritten?.(body.node);
      return true;
    } catch {
      setSubtasks(previous);
      toast.error(revertMessage);
      return false;
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }, [subtasks, node.id, workspace, updatedAt, toast, onConflict, onWritten]);

  const toggle = useCallback((id: string, done: boolean) => {
    const now = new Date().toISOString();
    return run(
      { op: "toggle", id, done },
      subtasks.map((s) => (s.id === id ? { ...s, done, done_at: done ? now : null } : s)),
      "Couldn’t update the subtask. It was reverted.",
    );
  }, [run, subtasks]);

  const remove = useCallback((id: string) => run(
    { op: "delete", id },
    subtasks.filter((s) => s.id !== id),
    "Couldn’t remove the subtask. It was put back.",
  ), [run, subtasks]);

  // Drafts get a temporary id so the row paints before the API names it;
  // the server's list (with the real id) replaces the whole list on success.
  const add = useCallback((title: string, summary: string) => {
    const now = new Date().toISOString();
    const draft: Subtask = {
      id: `draft-${now}`,
      title,
      summary,
      content_md: "",
      done: false,
      done_at: null,
      created_at: now,
      updated_at: now,
    };
    return run(
      { op: "add", title, summary, content_md: "" },
      [...subtasks, draft],
      "Couldn’t add the subtask.",
    );
  }, [run, subtasks]);

  const [removing, setRemoving] = useState<string | null>(null);
  const removingSubtask = removing ? subtasks.find((s) => s.id === removing) ?? null : null;
  const [adding, setAdding] = useState(false);

  const askToggle = (subtask: Subtask) => {
    if (!canWrite || saving) return;
    setPending({ id: subtask.id, done: !subtask.done });
  };
  const pendingSubtask = pending ? subtasks.find((s) => s.id === pending.id) ?? null : null;

  const confirm = (
    <>
      <ConfirmDialog
        open={removing !== null && removingSubtask !== null}
        title="Remove this subtask?"
        body={
          removingSubtask ? (
          <>
              <span className="text-[var(--ink)]">{removingSubtask.title}</span>
              {" and its notes are removed from this task for everyone. This cannot be undone."}
            </>
          ) : null
        }
        confirmLabel="Remove"
        icon={<Trash2 size={15} />}
        busy={saving}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (!removing) return;
          const id = removing;
          setRemoving(null);
          if (openId === id) setOpenId(null);
          void remove(id);
        }}
      />
      <ConfirmDialog
        open={pending !== null && pendingSubtask !== null}
        title={pending?.done ? "Mark this subtask as done?" : "Reopen this subtask?"}
        body={
          pendingSubtask ? (
          <>
              <span className="text-[var(--ink)]">{pendingSubtask.title}</span>
              {pending?.done
                ? " will count as finished for everyone reading this task, people and agents alike."
                : " will go back to open; its progress is recounted for everyone."}
            </>
          ) : null
        }
        confirmLabel={pending?.done ? "Mark as done" : "Reopen"}
        icon={<CheckSquare size={15} />}
        busy={saving}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (!pending) return;
          const next = pending;
          setPending(null);
          void toggle(next.id, next.done);
        }}
      />
    </>
  );

  if (open) {
    return (
      <div className={cn("flex flex-col", className)} data-testid="subtask-detail">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setOpenId(null)}
            className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[11.5px] text-[var(--ink-3)] hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
          >
            <ArrowLeft size={11} /> Subtasks
          </button>
          <span className="mono text-[10px] text-[var(--ink-mute)]">
            {openIndex + 1}/{subtasks.length}
          </span>
          <span className="ml-auto" />
          {canWrite ? (
            <Button
              isIconOnly
              variant="ghost"
              size="sm"
              isDisabled={saving}
              onPress={() => setRemoving(open.id)}
              aria-label={`Remove subtask ${open.title}`}
              className="icon-btn text-[var(--ink-3)]"
            >
              <Trash2 size={12} />
            </Button>
          ) : null}
          <SubtaskCheckbox subtask={open} disabled={!canWrite || saving} onToggle={() => askToggle(open)} />
        </div>
        <h3 className={cn("mt-3 text-[16px] font-semibold leading-snug tracking-[-0.01em]", open.done && "text-[var(--ink-3)]")}>
          {open.title}
        </h3>
        {open.summary ? <p className="mt-1 text-[13px] leading-relaxed text-[var(--ink-2)]">{open.summary}</p> : null}
        <div className="mt-4 border-t border-[var(--line)] pt-4">
          {open.content_md.trim() ? (
            <NodeMarkdown markdown={open.content_md} onOpenNode={onOpenNode} />
          ) : (
            <p className="text-[12.5px] text-[var(--ink-3)]">No details beyond the summary.</p>
          )}
        </div>
        {confirm}
      </div>
    );
  }

  const isWorkKind = node.kind === "task" || node.kind === "bug";
  if (subtasks.length === 0 && !isWorkKind) return <>{children}</>;

  return (
    <div className={cn("flex flex-col", className)}>
      {children}
      <section className={cn(children ? "mt-6" : "", "flex flex-col")} data-testid="subtasks">
        <div className="mono flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.08em] text-[var(--ink-mute)]">
          <ListChecks size={11} />
          <span>Subtasks</span>
          {progress.total > 0 ? (
            <span className="text-[var(--ink-3)]">
              {progress.done}/{progress.total}
            </span>
          ) : null}
          {canWrite && !adding && subtasks.length < SUBTASK_LIMITS.count ? (
            <Button
              size="sm"
              variant="ghost"
              isDisabled={saving}
              onPress={() => setAdding(true)}
              className="ml-auto h-6 gap-1 rounded-md px-1.5 text-[11px] normal-case tracking-normal text-[var(--ink-2)]"
            >
              <Plus size={11} /> Add
            </Button>
          ) : null}
        </div>
        {progress.total > 0 ? (
          <div className="mt-2 h-[2px] w-full overflow-hidden rounded-full bg-[var(--paper-3)]" aria-hidden>
            <div
              className="h-full rounded-full bg-[var(--ink-3)] transition-[width] duration-300 ease-out motion-reduce:transition-none"
              style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
            />
          </div>
        ) : null}
        {subtasks.length === 0 && !adding ? (
          <p className="mt-2 text-[12px] text-[var(--ink-3)]">
            No subtasks yet. {canWrite ? "Add one here, or an agent adds them with " : "An agent adds them with "}
            <span className="mono text-[11px]">subtasks_write</span>, one step at a time.
          </p>
        ) : subtasks.length === 0 ? null : (
          <ul className="mt-2 flex flex-col gap-1.5">
            {subtasks.map((subtask, index) => (
              <li
                key={subtask.id}
                className={cn(
                  "group flex items-start gap-3 rounded-[10px] bg-[var(--paper-2)] px-3.5 py-3 transition-[background-color,transform] duration-150 motion-reduce:transition-none",
                  "hover:-translate-y-px hover:bg-[var(--paper-3)]",
                )}
              >
                <button
                  type="button"
                  onClick={() => setOpenId(subtask.id)}
                  className="flex min-w-0 flex-1 flex-col text-left"
                  aria-label={`Open subtask ${index + 1}: ${subtask.title}`}
                >
                  <span className="flex items-baseline gap-2">
                    <span className="mono shrink-0 text-[10px] text-[var(--ink-mute)]">{index + 1}</span>
                    <span
                      className={cn(
                        "min-w-0 truncate text-[13px] font-medium leading-snug text-[var(--ink)]",
                        subtask.done && "text-[var(--ink-3)] line-through decoration-[var(--line-strong)]",
                      )}
                    >
                      {subtask.title}
                    </span>
                    <ChevronRight size={11} className="ml-auto shrink-0 self-center text-[var(--ink-mute)] opacity-0 transition-opacity group-hover:opacity-100 motion-reduce:transition-none" />
                  </span>
                  {subtask.summary ? (
                    <span className={cn("mt-0.5 line-clamp-2 text-[12px] leading-relaxed text-[var(--ink-3)]", subtask.done && "text-[var(--ink-mute)]")}>
                      {subtask.summary}
                    </span>
                  ) : null}
                </button>
                {canWrite ? (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => setRemoving(subtask.id)}
                    aria-label={`Remove subtask ${subtask.title}`}
                    className="mt-0.5 shrink-0 rounded-md p-1 text-[var(--ink-mute)] opacity-0 transition-opacity hover:bg-[var(--paper)] hover:text-[var(--ink)] focus-visible:opacity-100 group-hover:opacity-100 motion-reduce:transition-none"
                  >
                    <Trash2 size={12} />
                  </button>
                ) : null}
                <SubtaskCheckbox subtask={subtask} disabled={!canWrite || saving} onToggle={() => askToggle(subtask)} />
              </li>
            ))}
          </ul>
        )}
        {adding ? (
          <SubtaskDraftForm
            busy={saving}
            onCancel={() => setAdding(false)}
            onSubmit={async (title, summary) => {
              const ok = await add(title, summary);
              if (ok) setAdding(false);
              return ok;
            }}
          />
        ) : null}
      </section>
      {confirm}
    </div>
  );
}

function SubtaskCheckbox({
  subtask,
  disabled,
  onToggle,
}: {
  subtask: Subtask;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <Checkbox
      isSelected={subtask.done}
      isDisabled={disabled}
      // The dialog decides; the box itself never flips on its own.
      onChange={() => onToggle()}
      aria-label={subtask.done ? `Reopen ${subtask.title}` : `Mark ${subtask.title} as done`}
      className="mt-0.5 shrink-0"
    >
      <Checkbox.Content>
        <Checkbox.Control>
          <Checkbox.Indicator />
        </Checkbox.Control>
      </Checkbox.Content>
    </Checkbox>
  );
}

/**
 * The one-line creator: a title (required) and the summary the card will
 * show. Enter submits, Escape cancels; the body of a step is written by
 * opening it from an agent — here the point is to get the step on the list.
 */
function SubtaskDraftForm({
  busy,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  onSubmit: (title: string, summary: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const canSubmit = title.trim().length > 0 && !busy;
  const submit = () => {
    if (!canSubmit) return;
    void onSubmit(title.trim(), summary.trim());
  };
  const field = "w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-2.5 py-1.5 text-[12.5px] text-[var(--ink)] outline-none placeholder:text-[var(--ink-mute)] focus:border-[var(--line-strong)]";
  return (
    <form
      className="mt-2 flex flex-col gap-1.5 rounded-[10px] border border-[var(--line)] bg-[var(--paper-2)] p-2.5"
      data-testid="subtask-draft"
      onSubmit={(event) => { event.preventDefault(); submit(); }}
      onKeyDown={(event) => { if (event.key === "Escape") onCancel(); }}
    >
      <input
        autoFocus
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        maxLength={SUBTASK_LIMITS.title}
        placeholder="What is the step?"
        aria-label="Subtask title"
        className={field}
      />
      <input
        value={summary}
        onChange={(event) => setSummary(event.target.value)}
        maxLength={SUBTASK_LIMITS.summary}
        placeholder="One line on why it matters (optional)"
        aria-label="Subtask summary"
        className={field}
      />
      <div className="flex items-center justify-end gap-1.5">
        <Button size="sm" variant="ghost" isDisabled={busy} onPress={onCancel} className="h-7 gap-1 text-[11.5px]">
          <X size={11} /> Cancel
        </Button>
        <Button size="sm" variant="primary" isDisabled={!canSubmit} type="submit" className="h-7 gap-1 text-[11.5px]">
          <Plus size={11} /> Add subtask
        </Button>
      </div>
    </form>
  );
}
