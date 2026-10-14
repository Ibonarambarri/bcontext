"use client";

import { useActionState } from "react";
import {
  Alert,
  Button,
  Input,
  Label,
  ListBox,
  Select,
  TextField,
} from "@heroui/react";
import { CopyLink } from "@/components/admin/copy-link";
import { createInviteAction, type InviteFormState } from "../actions";

const ROLES = ["owner", "admin", "editor", "viewer"] as const;

/** Another way in, for a person the owner cannot add themselves yet. */
export function InviteForm({ orgId }: { orgId: string }) {
  const [state, action, pending] = useActionState<InviteFormState, FormData>(
    createInviteAction,
    {},
  );

  return (
    <div>
      <form action={action} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="org_id" value={orgId} />
        <TextField isRequired name="email" type="email" className="min-w-56 flex-1">
          <Label>Email</Label>
          <Input placeholder="colleague@acme.com" />
        </TextField>
        <Select name="role" defaultSelectedKey="admin" className="w-40">
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
        <Button type="submit" isPending={pending} variant="secondary">
          {pending ? "Creating…" : "Create link"}
        </Button>
      </form>

      {state.error && (
        <Alert role="alert" status="danger" className="mt-3">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{state.error}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {state.invite && (
        <div className="mt-3">
          <CopyLink url={state.invite.url} label="new link" />
        </div>
      )}
    </div>
  );
}
