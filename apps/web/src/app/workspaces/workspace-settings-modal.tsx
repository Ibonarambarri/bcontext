"use client";

import { useCallback, useState, useTransition } from "react";
import { Shield, X } from "lucide-react";
import { Button, Chip, Input, Label, Modal, TextField } from "@heroui/react";
import {
  GRADIENTS,
  gradientCss,
  gradientFor,
} from "@bcontext-dev/contract/workspace-gradients";
import { ToastViewport } from "@/components/toast";
import type { Toast, ToastKind } from "@/components/workspace-context";
import { workspaceApiRef } from "@/web/workspace-url";
import type { WorkspaceVM } from "./workspaces-view";
import { updateWorkspaceAction } from "./actions";

/**
 * A workspace's own settings: what it is called, and the colour it is
 * recognised by.
 *
 * This was a right-hand Sheet, in the same family as the agents drawer, and
 * the shape was wrong for what it holds. A drawer is for looking things up
 * while the page behind it stays the subject — a list you scan, a panel you
 * leave open. Renaming a workspace is the opposite: one deliberate act, two
 * fields, and then you are done and gone. The centred dialog says that, and it
 * puts this screen in the family it actually belongs to — the account dialog
 * and the organization panel, which are also things you open on purpose and
 * close when finished.
 *
 * It is deliberately small. Members, invitations and usage are the
 * organization's business and live in its panel, which the hub opens from its
 * own "Manage organization" button; nothing of that moved in here.
 *
 * The address is gone from the screen. A workspace's slug and its `/w/…` path
 * were printed under the name here for years, on the theory that people had
 * written them down — but they are fixed at creation, unclickable, and read as
 * machine residue in a dialog whose whole subject is the human-facing name.
 * The organization is still named, because which company a workspace belongs
 * to is a fact about it that a person can act on.
 */

interface Props {
  ws: WorkspaceVM;
  isAdmin: boolean;
  /** Does the interface name the organization? See `@/lib/org-layer`. */
  orgLayer: boolean;
  onClose: () => void;
}

/** Local, page-scoped toast stack — the /workspaces hub sits outside the
 *  per-workspace shell (no WorkspaceProvider), so it can't reach the app's
 *  toast context. Reuses the same Toast type + ToastViewport renderer. */
function useLocalToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: ToastKind, message: string) => {
    const id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : String(Date.now());
    setToasts((t) => [...t, { id, kind, message, createdAt: Date.now() }]);
  }, []);
  const dismiss = useCallback((id: string) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);
  return { toasts, push, dismiss };
}

export function WorkspaceSettingsModal({
  ws,
  isAdmin,
  orgLayer,
  onClose,
}: Props) {
  const { toasts, push, dismiss } = useLocalToasts();
  const grad = gradientFor({ slug: ws.slug, metadata: ws.metadata });
  // A slug only names a workspace inside its organization, so every write
  // travels as the `<org>~<workspace>` ref the API routes take. It is an
  // argument to the action, never something the reader is shown.
  const wsRef = workspaceApiRef({ org: ws.org.slug, slug: ws.slug });

  return (
    <>
      <Modal.Backdrop
        isOpen
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
        className="backdrop-blur-[6px]"
        style={{ background: "var(--ov-backdrop, rgba(0,0,0,0.55))" }}
      >
        <Modal.Container placement="center" className="p-4">
          <Modal.Dialog
            aria-label={`Settings for ${ws.name}`}
            className="relative flex max-h-[calc(100svh-48px)] w-full max-w-[560px] flex-col overflow-hidden rounded-[16px] border border-[var(--line)] bg-[var(--paper)] shadow-[0_30px_90px_-30px_rgba(0,0,0,0.55)]"
          >
            <Modal.CloseTrigger
              aria-label="Close (Esc)"
              className="absolute right-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-3)] hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
            >
              <X size={14} />
            </Modal.CloseTrigger>

            <header className="flex items-center gap-3.5 border-b border-[var(--line)] px-6 py-5 pr-14">
              <div
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[11px] text-[22px] font-semibold leading-none text-white"
                style={{
                  background: gradientCss(grad),
                  textShadow: "0 1px 1px rgba(0,0,0,.2)",
                }}
              >
                {ws.glyph}
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-[17px] font-semibold leading-tight tracking-[-0.01em] text-foreground">
                  {ws.name}
                </h2>
                <div className="truncate text-[12px] text-muted">
                  {orgLayer ? ws.org.name : "Workspace settings"}
                </div>
              </div>
              <Chip size="sm" variant="soft" className="shrink-0 capitalize">
                <Chip.Label>{ws.role}</Chip.Label>
              </Chip>
            </header>

            <div className="scroll min-h-0 flex-1 overflow-y-auto px-6 py-5">
              {isAdmin ? (
                <GeneralForm
                  ws={ws}
                  wsRef={wsRef}
                  onError={(msg) => push("error", msg)}
                />
              ) : (
                <div className="rounded-[10px] border border-border bg-surface/60 p-3.5">
                  <p className="m-0 text-[12.5px] leading-[1.55] text-muted">
                    <Shield size={13} className="mr-1.5 inline align-middle" />
                    You have <strong className="font-medium text-foreground">
                      {ws.role}
                    </strong>{" "}
                    access. Ask an admin to manage settings, members, or
                    invitations.
                  </p>
                </div>
              )}

            </div>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </>
  );
}

/**
 * The two things an administrator can change, saved by `updateWorkspaceAction`
 * (`./actions.ts`). Its contract is a `FormData`: `slug` carries the
 * `<org>~<workspace>` ref rather than the bare slug, `name` is only written
 * when it is non-empty, and `accent_gradient` is a preset id — so the chosen
 * swatch rides along as a hidden field and the swatch buttons are `type
 *="button"`, not submits.
 */
function GeneralForm({
  ws,
  wsRef,
  onError,
}: {
  ws: WorkspaceVM;
  wsRef: string;
  onError: (message: string) => void;
}) {
  const [pending, start] = useTransition();
  const initialGradient = gradientFor({ slug: ws.slug, metadata: ws.metadata });
  const [gradientId, setGradientId] = useState<string>(initialGradient.id);

  return (
    <form
      action={(fd) =>
        start(async () => {
          try {
            await updateWorkspaceAction(fd);
          } catch (err) {
            onError(
              err instanceof Error ? err.message : "Couldn't save changes.",
            );
          }
        })
      }
      className="space-y-5"
    >
      <input type="hidden" name="slug" value={wsRef} />
      <input type="hidden" name="accent_gradient" value={gradientId} />

      <TextField name="name" defaultValue={ws.name} isDisabled={pending} fullWidth>
        <Label>Name</Label>
        <Input />
      </TextField>

      <div>
        <div className="text-[13px] font-medium text-foreground">
          Accent gradient
        </div>
        <p className="mt-0.5 text-[12px] text-muted">
          How this workspace is picked out of a wall of them.
        </p>
        <div className="mt-2.5 flex flex-wrap gap-2">
          {GRADIENTS.map((g) => {
            const active = g.id === gradientId;
            return (
              <Button
                key={g.id}
                type="button"
                isIconOnly
                size="sm"
                variant="ghost"
                onPress={() => setGradientId(g.id)}
                aria-label={g.name}
                aria-pressed={active}
                className="h-7 w-7 min-w-7 shrink-0 rounded-lg border-2 p-0 transition-transform hover:scale-105"
                style={{
                  background: gradientCss(g),
                  borderColor: active ? "var(--ink)" : "transparent",
                  boxShadow: active ? "0 0 0 1px var(--paper) inset" : undefined,
                }}
              />
            );
          })}
        </div>
      </div>

      <div>
        <Button type="submit" isPending={pending}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
