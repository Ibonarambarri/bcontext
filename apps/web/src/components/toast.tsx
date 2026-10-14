"use client";

/**
 * The toast stack, bottom-right — lifted above the Nexo bubble whenever the
 * bubble is on the page (`[data-nexo-launcher]`), so neither hides the other. Presentational: the queue and the
 * `toast.info/error` API live in the workspace context (`ToastApi`), and
 * `workspace-shell.tsx` bridges the two; the hub's settings modal mounts it
 * with its own local list. Errors are `role="alert"` (assertive), the rest
 * `status` (polite). Beyond five, the oldest collapse behind "+N more".
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { CloseButton } from "@heroui/react";
import type { Toast } from "./workspace-context";
import { cn } from "@bcontext-dev/contract/utils";

const MAX_VISIBLE = 5;

export function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  if (toasts.length === 0) return null;

  const overflow = Math.max(0, toasts.length - MAX_VISIBLE);
  const visible = expanded ? toasts : toasts.slice(-MAX_VISIBLE);

  return (
    <div
      role="region"
      aria-label="Notifications"
      aria-relevant="additions"
      className="pointer-events-none fixed bottom-3 right-3 z-50 flex w-72 max-w-[calc(100vw-1.5rem)] flex-col gap-1.5 [body:has([data-nexo-launcher])_&]:bottom-[68px]"
    >
      {overflow > 0 && !expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="pointer-events-auto self-end rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-0.5 text-[10px] text-[var(--fg-muted)] shadow-sm hover:text-[var(--fg)]"
        >
          +{overflow} more
        </button>
      ) : null}
      {visible.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
      {expanded && toasts.length > MAX_VISIBLE ? (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="pointer-events-auto self-end rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-0.5 text-[10px] text-[var(--fg-muted)] shadow-sm hover:text-[var(--fg)]"
        >
          Collapse
        </button>
      ) : null}
    </div>
  );
}

/**
 * One toast with its own auto-dismiss timer. The timer pauses while the
 * pointer or focus is on it and resumes with the time that was left — a
 * toast with an Undo button must not vanish under the cursor.
 */
function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: string) => void;
}) {
  // A toast that offers an action gets longer: it is asking for a decision.
  const ttl = toast.duration ?? (toast.action ? 9000 : 4000);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remainingRef = useRef<number>(ttl);
  const startedAtRef = useRef<number>(Date.now());
  const pausedRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startTimer = useCallback(
    (ms: number) => {
      clearTimer();
      startedAtRef.current = Date.now();
      remainingRef.current = ms;
      timerRef.current = setTimeout(() => onDismiss(toast.id), ms);
    },
    [clearTimer, onDismiss, toast.id],
  );

  useEffect(() => {
    remainingRef.current = ttl;
    startTimer(ttl);
    return clearTimer;
  }, [toast.id, toast.createdAt, ttl, startTimer, clearTimer]);

  const onPause = useCallback(() => {
    if (pausedRef.current) return;
    pausedRef.current = true;
    const elapsed = Date.now() - startedAtRef.current;
    remainingRef.current = Math.max(0, remainingRef.current - elapsed);
    clearTimer();
  }, [clearTimer]);

  const onResume = useCallback(() => {
    if (!pausedRef.current) return;
    pausedRef.current = false;
    startTimer(remainingRef.current > 0 ? remainingRef.current : ttl);
  }, [startTimer, ttl]);

  return (
    <div
      role={toast.kind === "error" ? "alert" : "status"}
      aria-live={toast.kind === "error" ? "assertive" : "polite"}
      data-slot="toast"
      data-variant={toast.kind === "error" ? "danger" : "default"}
      onPointerEnter={onPause}
      onPointerLeave={onResume}
      onFocus={onPause}
      onBlur={onResume}
      tabIndex={0}
      className={cn(
        "toast pointer-events-auto fade-in flex items-start gap-2 rounded-md border bg-[var(--bg)] px-2.5 py-1.5 text-xs shadow-sm outline-none focus:border-[var(--border-strong)]",
        toast.kind === "error"
          ? "toast--danger border-[var(--border-strong)] text-[var(--fg)]"
          : "toast--default border-[var(--border)] text-[var(--fg-muted)]",
      )}
    >
      <div
        data-slot="toast-content"
        className="toast__content min-w-0 flex-1 break-words leading-snug"
      >
        {toast.message}
      </div>
      {toast.action ? (
        <button
          type="button"
          data-slot="toast-action"
          onClick={() => {
            toast.action?.onPress();
            onDismiss(toast.id);
          }}
          className="shrink-0 rounded-[5px] border border-[var(--border)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--fg)] hover:bg-[var(--bg-muted)]"
        >
          {toast.action.label}
        </button>
      ) : null}
      <CloseButton
        data-slot="toast-close"
        onPress={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
        className="toast__close shrink-0 size-4 min-h-0 min-w-0 p-0 text-[var(--fg-subtle)] hover:text-[var(--fg)] [&_svg]:size-3"
      />
    </div>
  );
}
