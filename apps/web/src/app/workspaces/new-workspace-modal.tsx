"use client";

/**
 * Creating a workspace, from the hub, in a dialog.
 *
 * This used to be a page of its own (`/onboard`, a two-step "wizard" in the
 * paper shell the sign-up flow is written on). That shape made sense when
 * the first workspace was the first thing a new account ever saw; now an
 * account arrives through `/start` or an invitation, lands on the hub, and
 * "one more workspace" is something an administrator does between two other
 * things — the same gesture as opening the organization panel or a
 * workspace's settings, so it is the same kind of dialog, centred and
 * closable, with the hub still visible behind it.
 *
 * One screen, three questions at most: which organization (only when there
 * is more than one to choose from), the name, and what it starts with. THE
 * ADDRESS IS NOT ASKED FOR, and must not be added back: the create body is
 * `{ name, organization, template }`, and the server derives the slug from
 * the name and numbers it if the organization already has one (`acme`,
 * `acme-2`). Success goes straight into the new workspace.
 *
 * Writes `POST /api/onboarding/create`. `apiErrorMessage` is exported for
 * `new-workspace-modal.test.ts`.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { LayoutGrid, X } from "lucide-react";
import {
  Button,
  Input,
  Label,
  ListBox,
  Modal,
  Select,
  TextField,
} from "@heroui/react";
import { cn } from "@bcontext-dev/contract/utils";
import type { OrganizationVM } from "./workspaces-view";

/** A workspace template as `page.tsx` summarises it from the contract. */
export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  node_count: number;
}

interface Props {
  /** Every organization on the hub; only the creatable ones are offered. */
  organizations: OrganizationVM[];
  /** The one the person was looking at when they asked, if any. */
  initialOrganization: OrganizationVM | null;
  /** Does the dialog name the organization? See `@/lib/org-layer`. */
  orgLayer: boolean;
  templates: TemplateSummary[];
  onClose: () => void;
}

/**
 * What the API said went wrong, in the words it used.
 *
 * The route answers a validation failure with a flattened Zod error and
 * nothing else, so "HTTP 400" was all a person saw for a body missing a field
 * the screen never asked them for. Whatever shape comes back, something a
 * human wrote is preferred to the status line.
 */
export function apiErrorMessage(body: unknown, status: number): string {
  const fallback = `Couldn't create the workspace (HTTP ${status}).`;
  if (!body || typeof body !== "object") return fallback;
  const { message, error } = body as { message?: unknown; error?: unknown };
  if (typeof message === "string" && message.trim()) return message;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const flattened = error as {
      formErrors?: unknown;
      fieldErrors?: Record<string, unknown>;
    };
    const form = Array.isArray(flattened.formErrors) ? flattened.formErrors : [];
    const fields = Object.entries(flattened.fieldErrors ?? {}).flatMap(
      ([field, issues]) =>
        (Array.isArray(issues) ? issues : []).map((issue) => `${field}: ${issue}`),
    );
    const first = [...form, ...fields].find(
      (issue): issue is string => typeof issue === "string" && issue.length > 0,
    );
    if (first) return first;
  }
  return fallback;
}

export function NewWorkspaceModal({
  organizations,
  initialOrganization,
  orgLayer,
  templates,
  onClose,
}: Props) {
  const router = useRouter();

  // A workspace is created inside an organization the person administers.
  // Most people have exactly one, so the choice is made for them and never
  // shown; several is a picker, defaulting to the one they came from.
  const creatable = useMemo(
    () => organizations.filter((org) => org.canCreateWorkspace),
    [organizations],
  );
  const [organization, setOrganization] = useState<string>(() => {
    if (initialOrganization?.canCreateWorkspace) return initialOrganization.slug;
    return creatable[0]?.slug ?? "";
  });
  const chosenOrg = creatable.find((org) => org.slug === organization) ?? null;

  const [name, setName] = useState("");
  const defaultTemplate = useMemo(
    () => templates.find((t) => t.id === "startup-founder")?.id ?? templates[0]?.id ?? "",
    [templates],
  );
  const [templateId, setTemplateId] = useState(defaultTemplate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = name.trim().length > 0 && organization !== "" && !busy;

  async function submit() {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/onboarding/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          organization,
          template: templateId || undefined,
        }),
      });
      const data = (await r.json()) as { next_url?: string };
      if (!r.ok) throw new Error(apiErrorMessage(data, r.status));
      // Straight in. The hub behind this dialog is stale the moment the
      // workspace exists, and the workspace is where the person was going.
      router.push((data.next_url ?? "/workspaces") as Route);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the workspace.");
      setBusy(false);
    }
  }

  return (
    <Modal.Backdrop
      isOpen
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      className="backdrop-blur-[6px]"
      style={{ background: "var(--ov-backdrop, rgba(0,0,0,0.55))" }}
    >
      <Modal.Container placement="center" className="p-4">
        <Modal.Dialog
          aria-label="New workspace"
          className="relative flex max-h-[calc(100svh-48px)] w-full max-w-[560px] flex-col overflow-hidden rounded-[16px] border border-[var(--line)] bg-[var(--paper)] shadow-[0_30px_90px_-30px_rgba(0,0,0,0.55)]"
        >
          <Modal.CloseTrigger
            aria-label="Close (Esc)"
            className="absolute right-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-3)] hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
          >
            <X size={14} />
          </Modal.CloseTrigger>

          <header className="flex items-center gap-3.5 border-b border-[var(--line)] px-6 py-5 pr-14">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[11px] border border-dashed border-[var(--line-strong)] text-[var(--ink-3)]">
              <LayoutGrid size={18} />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-[17px] font-semibold leading-tight tracking-[-0.01em] text-foreground">
                New workspace
              </h2>
              <div className="truncate text-[12px] text-muted">
                {orgLayer && chosenOrg
                  ? `In ${chosenOrg.name}`
                  : "One per product, team or client, with its own members and agents."}
              </div>
            </div>
          </header>

          <form
            className="scroll min-h-0 flex-1 overflow-y-auto px-6 py-5"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div className="space-y-5">
              {creatable.length > 1 ? (
                <Select
                  aria-label="Organization"
                  value={organization}
                  onChange={(key) => setOrganization(key == null ? "" : String(key))}
                  isDisabled={busy}
                  fullWidth
                >
                  <Label>Organization</Label>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {creatable.map((org) => (
                        <ListBox.Item key={org.slug} id={org.slug} textValue={org.name}>
                          {org.name}
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
              ) : null}

              <TextField
                value={name}
                onChange={setName}
                isDisabled={busy}
                autoFocus
                fullWidth
              >
                <Label>Name</Label>
                <Input placeholder="Acme" maxLength={80} />
              </TextField>

              <div>
                <div className="text-[13px] font-medium text-foreground">
                  Starting point
                </div>
                <p className="mt-0.5 text-[12px] text-muted">
                  A template comes with a handful of nodes and tags so the
                  workspace is not empty on day one. Delete what you don&apos;t
                  want.
                </p>
                <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {templates.map((t) => (
                    <TemplateCard
                      key={t.id}
                      title={t.name}
                      meta={t.description}
                      count={`${t.node_count} nodes`}
                      active={templateId === t.id}
                      disabled={busy}
                      onPress={() => setTemplateId(t.id)}
                    />
                  ))}
                  <TemplateCard
                    title="Empty"
                    meta="Start from nothing."
                    active={templateId === ""}
                    disabled={busy}
                    onPress={() => setTemplateId("")}
                  />
                </div>
              </div>

              {error ? (
                <p
                  role="alert"
                  className="rounded-[10px] border border-danger/40 bg-danger/10 px-3.5 py-2.5 text-[12.5px] leading-[1.5] text-danger"
                >
                  {error}
                </p>
              ) : null}
            </div>
          </form>

          <footer className="flex items-center justify-end gap-2 border-t border-[var(--line)] px-6 py-4">
            <Button variant="ghost" size="sm" isDisabled={busy} onPress={onClose}>
              Cancel
            </Button>
            <Button size="sm" isDisabled={!ready} isPending={busy} onPress={() => void submit()}>
              {busy ? "Creating…" : "Create workspace"}
            </Button>
          </footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

/**
 * One starting point. A pressed button rather than a radio, in the same
 * family as the gradient picker in a workspace's settings: the picked one
 * reads as ink on paper, and there is exactly one filled shape in the dialog,
 * which is the button at the bottom.
 */
function TemplateCard({
  title,
  meta,
  count,
  active,
  disabled,
  onPress,
}: {
  title: string;
  meta: string;
  count?: string;
  active: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      aria-pressed={active}
      isDisabled={disabled}
      onPress={onPress}
      className={cn(
        // HeroUI's button is fit-content and nowrap; a card is a grid cell
        // whose text wraps, or the row overflows the dialog sideways.
        "flex h-auto w-full min-w-0 flex-col items-start gap-1 whitespace-normal rounded-[12px] border px-3.5 py-3 text-left font-normal transition-colors",
        active
          ? "border-[var(--ink)] bg-[var(--paper)] shadow-[inset_0_0_0_1px_var(--ink)]"
          : "border-[var(--line)] bg-[var(--paper-2)] hover:border-[var(--ink-3)]",
      )}
    >
      <span className="block text-[13.5px] font-medium text-foreground">{title}</span>
      <span className="block text-[12px] leading-[1.45] text-muted">{meta}</span>
      {count ? (
        <span className="font-mono text-[10.5px] text-[var(--ink-3)]">{count}</span>
      ) : null}
    </Button>
  );
}
