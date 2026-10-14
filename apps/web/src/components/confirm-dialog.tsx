"use client";

/**
 * The one confirmation dialog. Before this, every destructive or
 * state-changing confirmation in the app was the browser's native
 * `confirm()`, which cannot say more than a sentence, cannot show a busy
 * state, and looks like nothing else on screen. This is the same
 * AlertDialog shape the agent-disconnect flow already uses, with the copy
 * and the tone (neutral or danger) passed in.
 */

import { AlertDialog, Button } from "@heroui/react";
import type { ReactNode } from "react";

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "neutral",
  icon,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "neutral" | "danger";
  icon?: ReactNode;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <AlertDialog.Backdrop
      isOpen
      isDismissable={!busy}
      onOpenChange={(next) => {
        if (!next && !busy) onCancel();
      }}
    >
      <AlertDialog.Container placement="center">
        <AlertDialog.Dialog aria-labelledby="confirm-dialog-title" className="w-full max-w-[420px]">
          <AlertDialog.Header className="flex-col items-start gap-0">
            {icon ? (
              <AlertDialog.Icon status={tone === "danger" ? "danger" : "default"}>{icon}</AlertDialog.Icon>
            ) : null}
            <AlertDialog.Heading id="confirm-dialog-title" className={icon ? "mt-4 text-[15px] font-medium" : "text-[15px] font-medium"}>
              {title}
            </AlertDialog.Heading>
          </AlertDialog.Header>
          {body ? (
            <AlertDialog.Body>
              <div className="mt-1 text-[12px] leading-relaxed text-[var(--ink-3)]">{body}</div>
            </AlertDialog.Body>
          ) : null}
          <AlertDialog.Footer className="flex">
            <Button isDisabled={busy} onPress={onCancel} variant="outline" size="sm">
              {cancelLabel}
            </Button>
            <Button
              isDisabled={busy}
              onPress={onConfirm}
              variant={tone === "danger" ? "danger" : "primary"}
              size="sm"
              className="ml-auto"
              autoFocus
            >
              {confirmLabel}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}
