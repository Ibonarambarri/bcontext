"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, Plus } from "lucide-react";
import {
  Button,
  Description,
  Input,
  Label,
  ListBox,
  Select,
  TextField,
} from "@heroui/react";
import { Sheet } from "@/components/ui/sheet";
import { CopyLink } from "@/components/admin/copy-link";
import { createOrgAction, type OrgFormState } from "./actions";

const ROLES = ["owner", "admin", "editor", "viewer"] as const;

/** The shape the panel posts through. */
type CreateOrgFormAction = (
  prev: OrgFormState,
  formData: FormData,
) => Promise<OrgFormState>;

/**
 * Creating an organization and the invitation for its first owner.
 *
 * The form lives in a panel rather than above the list because creating a
 * company is a rare act and the list is what the operator came to read. It
 * slides in from the right like the organization settings in the app itself,
 * so the two places you shape an organization look like the same product.
 *
 * The result is a link, and the link is the whole point: it stays on screen
 * until the panel is dismissed, and the row behind it carries the same link
 * for as long as the invitation is pending — nothing here is the last place
 * it can be read.
 *
 * The panel is open-only: the caller mounts it when it should be on screen
 * and unmounts it on `onClose`, so a second opening starts from an empty
 * form rather than from the last thing that was created.
 */
function CreateOrgSheet({
  action,
  onClose,
}: {
  action: CreateOrgFormAction;
  onClose: () => void;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<OrgFormState, FormData>(
    action,
    {},
  );
  const created = state.created;
  const formRef = useRef<HTMLFormElement>(null);

  // The list behind the panel is a projection of what was just created, so it
  // is re-read as soon as the API confirms. The form is emptied at the same
  // time: the next organization is a different company, never an edit of this
  // one.
  useEffect(() => {
    if (!created) return;
    formRef.current?.reset();
    router.refresh();
  }, [created, router]);

  return (
    <Sheet
      isOpen
      placement="right"
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <Sheet.Backdrop variant="opaque">
        <Sheet.Content className="w-[560px] max-w-full">
          <Sheet.Dialog aria-label="New organization">
            <Sheet.Header className="flex-row items-center gap-3 border-b border-[var(--line)]">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] bg-[var(--paper-3)]">
                <Building2 size={16} className="text-[var(--ink-2)]" />
              </div>
              <div className="min-w-0 flex-1">
                <Sheet.Heading className="truncate text-[15px] font-medium">
                  New organization
                </Sheet.Heading>
                <p className="font-mono text-[10.5px] text-[var(--ink-3)]">
                  /w/&lt;slug&gt;
                </p>
              </div>
              <Sheet.CloseTrigger />
            </Sheet.Header>

            <Sheet.Body className="min-h-0 overflow-y-auto p-5">
              <p className="text-[12px] text-[var(--ink-3)]">
                Creates the organization and the invitation that hands it
                to its first owner. Nothing is emailed — you get a link to
                send yourself, and the branded email is one click away on
                the organization&apos;s page.
              </p>

              <form ref={formRef} action={formAction} className="mt-5 space-y-4">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <TextField isRequired name="name" autoComplete="off">
                    <Label>Organization name</Label>
                    <Input autoFocus placeholder="Acme Inc." />
                  </TextField>
                  <TextField name="slug" autoComplete="off">
                    <Label>Address</Label>
                    <Input placeholder="acme" className="font-mono" />
                    <Description>
                      Derived from the name when left empty, and fixed from
                      then on.
                    </Description>
                  </TextField>
                  <TextField
                    isRequired
                    name="owner_email"
                    type="email"
                    autoComplete="off"
                  >
                    <Label>Owner email</Label>
                    <Input placeholder="ana@acme.com" className="font-mono" />
                  </TextField>
                  <Select name="role" defaultSelectedKey="owner">
                    <Label>Role</Label>
                    <Select.Trigger>
                      <Select.Value />
                      <Select.Indicator />
                    </Select.Trigger>
                    <Select.Popover>
                      <ListBox>
                        {ROLES.map((r) => (
                          <ListBox.Item key={r} id={r} textValue={r}>
                            <Label>{r}</Label>
                            <ListBox.ItemIndicator />
                          </ListBox.Item>
                        ))}
                      </ListBox>
                    </Select.Popover>
                  </Select>
                </div>

                <div className="flex items-center gap-3 pt-1">
                  <Button type="submit" isPending={pending}>
                    {pending ? "Creating…" : "Create organization"}
                  </Button>
                  {state.error && (
                    <span
                      role="alert"
                      className="text-[11.5px] text-[var(--danger,#dc2626)]"
                    >
                      {state.error}
                    </span>
                  )}
                </div>
              </form>

              {created && (
                <div className="mt-6 rounded-md border border-[var(--line)] bg-[var(--paper-2)] p-4">
                  <p className="text-[13px] text-[var(--ink)]">
                    <strong className="font-medium">{created.org.name}</strong>{" "}
                    is ready. Send this link to{" "}
                    <span className="font-mono text-[12.5px]">
                      {created.invite.email}
                    </span>{" "}
                    — it creates their account and drops them in as{" "}
                    {created.invite.role}.
                  </p>
                  <div className="mt-3">
                    <CopyLink url={created.invite.url} />
                  </div>
                  <p className="mt-2 text-[11px] text-[var(--ink-3)]">
                    The same link sits on the organization&apos;s row until the
                    invitation is accepted or revoked.
                  </p>
                </div>
              )}
            </Sheet.Body>
          </Sheet.Dialog>
        </Sheet.Content>
      </Sheet.Backdrop>
    </Sheet>
  );
}

/** The Organizations screen's own entry point: the button and the panel. */
export function CreateOrgDrawer() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button size="sm" className="shrink-0" onPress={() => setOpen(true)}>
        <Plus size={13} /> New organization
      </Button>

      {open ? (
        <CreateOrgSheet
          action={createOrgAction}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
