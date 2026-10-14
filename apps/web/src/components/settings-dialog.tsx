"use client";

import { useEffect, useState, useTransition } from "react";
import {
  Loader2,
  LogOut,
  Settings as SettingsIcon,
  X,
} from "lucide-react";
import { Modal } from "@heroui/react";
import { cn } from "@bcontext-dev/contract/utils";
import { density as densityStore, type Density } from "@/lib/local-settings";
import { displayName } from "@bcontext-dev/contract/me";
import { useMe } from "@/hooks/use-me";
import { useWorkspace } from "./workspace-context";
import {
  GRADIENTS,
  gradientCss,
  gradientFor,
} from "@bcontext-dev/contract/workspace-gradients";
import {
  updateWorkspaceAction,
} from "@/app/workspaces/actions";
import { getSupabaseBrowser } from "@/lib/supabase/browser";
import {
  workspaceApiRef,
  workspaceName,
} from "@/web/workspace-url";
import { TagManager } from "./tag-manager";
import { supabaseAuthConfigured } from "@/lib/public-env";

type Tab =
  | "ws-appearance"
  | "ws-tags"
  | "ws-data"
  | "you-display";

interface TabSpec {
  id: Tab;
  label: string;
}

const WORKSPACE_TABS: TabSpec[] = [
  { id: "ws-appearance", label: "Appearance" },
  { id: "ws-tags", label: "Tags" },
  { id: "ws-data", label: "Data" },
];

const YOU_TABS: TabSpec[] = [
  { id: "you-display", label: "Display" },
];

/**
 * Workspace + personal settings dialog (⌘, or the user menu), mounted by
 * `workspace-shell.tsx` and opened through the workspace context's
 * `settingsOpen`. Two rails:
 *
 *   Workspace — Appearance (name + gradient, a server action), Tags (the
 *               shared `TagManager`), Data (export ZIP link)
 *   You       — Display (density + node panel size, this device)
 *
 * Workspace-scoped tabs assume an active workspace. "You" tabs are
 * user-level and persist to `localStorage` (`@/lib/local-settings`); the
 * node panel size also goes to Supabase Auth user metadata via the context.
 */
export function SettingsDialog() {
  const { settingsOpen, closeSettings } = useWorkspace();
  const [tab, setTab] = useState<Tab>("ws-appearance");

  if (!settingsOpen) return null;

  return (
    <Modal.Backdrop
      isOpen
      onOpenChange={(next) => {
        if (!next) closeSettings();
      }}
      className="backdrop-blur-[4px]"
      style={{ background: "var(--ov-backdrop)" }}
    >
      <Modal.Container
        placement="top"
        className="px-3 pt-[6vh] sm:px-4 sm:pt-[10vh]"
      >
        <Modal.Dialog
          aria-label="Settings"
          className="relative flex h-[88dvh] max-h-[620px] w-full max-w-[820px] flex-col overflow-hidden rounded-[14px] border border-[var(--line)] bg-[var(--paper)] shadow-[0_30px_90px_-30px_rgba(0,0,0,0.5)] md:h-[560px] md:flex-row"
        >
        <Modal.CloseTrigger
          aria-label="Close settings (Esc)"
          className="absolute right-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-3)] hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
        >
          <X size={14} />
        </Modal.CloseTrigger>

        <nav
          aria-label="Settings sections"
          className="flex w-full shrink-0 flex-row gap-1 overflow-x-auto border-b border-[var(--line)] bg-[var(--paper-2)] p-2 pr-10 md:w-[220px] md:flex-col md:gap-0.5 md:overflow-x-visible md:border-b-0 md:border-r md:pr-2"
        >
          <div className="fld-title hidden items-center gap-2 px-2.5 pb-3 pt-1 text-[13px] text-[var(--ink)] md:flex">
            <SettingsIcon size={13} className="text-[var(--ink-3)]" />
            Settings
          </div>

          <RailGroup label="Workspace">
            {WORKSPACE_TABS.map((t) => (
              <RailRow
                key={t.id}
                active={tab === t.id}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </RailRow>
            ))}
          </RailGroup>

          <RailGroup label="You">
            {YOU_TABS.map((t) => (
              <RailRow
                key={t.id}
                active={tab === t.id}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </RailRow>
            ))}
          </RailGroup>
        </nav>

        <div className="scroll min-w-0 flex-1 overflow-y-auto px-5 py-5 md:px-7 md:py-6">
          <TabHeader tab={tab} />
          <div className="mt-4">
            {tab === "ws-appearance" && <AppearanceTab />}
            {tab === "ws-tags" && <TagManager />}
            {tab === "ws-data" && <DataTab />}
            {tab === "you-display" && <DisplayTab />}
          </div>
        </div>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function TabHeader({ tab }: { tab: Tab }) {
  const titles: Record<Tab, { title: string; hint?: string }> = {
    "ws-appearance": {
      title: "Appearance",
      hint: "Workspace name, slug, and accent gradient.",
    },
    "ws-tags": {
      title: "Tags",
      hint: "Reusable multi-value taxonomy for this workspace.",
    },
    "ws-data": {
      title: "Data",
      hint: "Export everything in this workspace.",
    },
    "you-display": {
      title: "Display",
      hint: "Density, text size, panel sizes. Stored on this device.",
    },
  };
  const t = titles[tab];
  return (
    <div>
      <h2 className="fld-title text-[16px] text-[var(--ink)]">
        {t.title}
      </h2>
      {t.hint && (
        <p className="mt-0.5 text-[12px] text-[var(--ink-3)]">{t.hint}</p>
      )}
    </div>
  );
}

function RailGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="mono hidden px-2.5 pb-1 pt-3 text-[10.5px] uppercase tracking-[0.06em] text-[var(--ink-mute)] md:block">
        {label}
      </div>
      {children}
    </>
  );
}

function RailRow({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex shrink-0 items-center gap-2 whitespace-nowrap rounded-[7px] px-2.5 py-1.5 text-left text-[12.5px] md:w-full",
        active
          ? "bg-[var(--paper)] text-[var(--ink)]"
          : "text-[var(--ink-2)] hover:bg-[var(--paper)] hover:text-[var(--ink)]",
      )}
    >
      {children}
    </button>
  );
}

/* ─── Workspace > Appearance ──────────────────────────────────────────── */

function AppearanceTab() {
  const { workspace, address } = useWorkspace();
  const [pending, start] = useTransition();
  const [name, setName] = useState(workspace?.name ?? address.slug);
  const initialGradient = gradientFor({
    slug: address.slug,
    metadata: workspace?.metadata ?? null,
  });
  const [gradientId, setGradientId] = useState<string>(initialGradient.id);
  const [saved, setSaved] = useState(false);

  return (
    <form
      action={(fd) =>
        start(async () => {
          await updateWorkspaceAction(fd);
          setSaved(true);
          setTimeout(() => setSaved(false), 1500);
        })
      }
      className="space-y-5"
    >
      <input type="hidden" name="slug" value={workspaceApiRef(address)} />
      <input type="hidden" name="accent_gradient" value={gradientId} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <LabelledField label="Workspace name">
          <input
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8 w-full rounded border border-[var(--line)] bg-[var(--paper-2)] px-2 text-[13px] outline-none focus:border-[var(--line-strong)]"
          />
        </LabelledField>
        <LabelledField
          label="Address"
          hint="Derived from the name when the workspace was created, and fixed since: people and agents have written it down."
        >
          <div className="flex h-8 items-center rounded border border-[var(--line)] bg-[var(--paper-2)] px-2 font-mono text-[13px] text-[var(--ink-2)]">
            /w/{workspaceName(address)}
          </div>
        </LabelledField>
      </div>

      <div>
        <FieldLabel>Accent gradient</FieldLabel>
        <div className="mt-1.5 flex flex-wrap gap-2">
          {GRADIENTS.map((g) => {
            const active = g.id === gradientId;
            return (
              <button
                type="button"
                key={g.id}
                onClick={() => setGradientId(g.id)}
                title={g.name}
                aria-label={g.name}
                aria-pressed={active}
                className={cn(
                  "h-8 w-12 rounded-md ring-offset-2 ring-offset-[var(--paper)] transition-shadow",
                  active
                    ? "ring-2 ring-[var(--ink)]"
                    : "ring-0 hover:ring-1 hover:ring-[var(--ink-3)]",
                )}
                style={{ background: gradientCss(g) }}
              />
            );
          })}
        </div>
        <p className="mt-1.5 text-[11px] text-[var(--ink-3)]">
          Used as the workspace glyph background and accent across the app.
        </p>
      </div>

      <div className="flex items-center gap-3 pt-1">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--ink)] px-3 text-[12.5px] font-medium text-[var(--paper)] disabled:opacity-60"
        >
          {pending ? (
            <>
              <Loader2 size={12} className="animate-spin" /> Saving
            </>
          ) : (
            "Save changes"
          )}
        </button>
        {saved && (
          <span className="text-[11.5px] text-[var(--ink-3)]">Saved.</span>
        )}
      </div>
    </form>
  );
}

/* ─── Workspace > Data ────────────────────────────────────────────────── */

function DataTab() {
  const { address } = useWorkspace();
  const href = `/api/workspaces/${encodeURIComponent(workspaceApiRef(address))}/export`;
  return (
    <div className="space-y-3">
      <p className="text-[12.5px] leading-relaxed text-[var(--ink-2)]">
        Download every node in{" "}
        <code className="rounded bg-[var(--paper-3)] px-1 py-px text-[11px] font-mono">
          {workspaceName(address)}
        </code>{" "}
        as a flat schema-v2 ZIP of Markdown files. Each file carries semantic
        kind and first-class tags; filesystem paths and category are omitted.
      </p>
      <a
        href={href}
        download={`${address.slug}.zip`}
        className="inline-flex h-8 items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--paper-2)] px-3 text-[12.5px] text-[var(--ink-2)] hover:bg-[var(--paper-3)] hover:text-[var(--ink)]"
      >
        Export workspace ZIP
      </a>
    </div>
  );
}

/* ─── You > Display ───────────────────────────────────────────────────── */

function DisplayTab() {
  const { nodePanelSize, setNodePanelSize } = useWorkspace();
  const { me } = useMe();
  const [d, setD] = useState<Density>("cozy");
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    setD(densityStore.get());
  }, []);

  useEffect(() => {
    if (!supabaseAuthConfigured()) {
      return;
    }
    const supabase = getSupabaseBrowser();
    let cancelled = false;
    supabase.auth.getUser().then(({ data }) => {
      if (cancelled) return;
      setEmail(data.user?.email ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function pick(next: Density) {
    setD(next);
    densityStore.set(next);
    document.documentElement.dataset.density = next;
  }

  return (
    <div className="space-y-5">
      {email && (
        <div className="rounded-md border border-[var(--line)] bg-[var(--paper-2)] px-3 py-2.5">
          <div className="mono text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">
            Signed in as
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-[12.5px] text-[var(--ink)]">
              {/* The name is the account's and is edited in the profile
                  dialog (user menu → Profile); this only reports it. */}
              {me ? displayName(me.user) : email}
              {me && me.user.email && displayName(me.user) !== me.user.email ? (
                <span className="ml-1.5 text-[11.5px] text-[var(--ink-3)]">
                  {me.user.email}
                </span>
              ) : null}
            </span>
            <form action="/auth/signout" method="post">
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2 py-1 text-[11.5px] text-[var(--ink-2)] hover:bg-[var(--paper-3)] hover:text-[var(--ink)]"
              >
                <LogOut size={11} /> Sign out
              </button>
            </form>
          </div>
        </div>
      )}

      <LabelledField label="Density" hint="Sidebar row spacing + editor font size.">
        <ChipGroup
          value={d}
          onChange={pick}
          options={[
            { id: "compact", label: "Compact" },
            { id: "cozy", label: "Cozy" },
            { id: "comfortable", label: "Comfortable" },
          ]}
        />
      </LabelledField>

      <LabelledField label="Node panel" hint="Nodes open in a floating panel over the current view. How much of it the panel takes by default; you can toggle from the panel itself.">
        <ChipGroup
          value={nodePanelSize}
          onChange={setNodePanelSize}
          options={[
            { id: "half", label: "Half" },
            { id: "full", label: "Full" },
          ]}
        />
      </LabelledField>
    </div>
  );
}

/* ─── Shared field UI ────────────────────────────────────────────────── */

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mono text-[10px] uppercase tracking-[0.08em] text-[var(--ink-mute)]">
      {children}
    </div>
  );
}

function LabelledField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div className="mt-1">{children}</div>
      {hint && (
        <p className="mt-1 text-[11px] text-[var(--ink-3)]">{hint}</p>
      )}
    </div>
  );
}

function ChipGroup<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { id: T; label: string }[];
}) {
  return (
    <div role="radiogroup" className="flex gap-1">
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          role="radio"
          aria-checked={value === opt.id}
          onClick={() => onChange(opt.id)}
          className={cn(
            "flex-1 rounded border px-2 py-1.5 text-[12px]",
            value === opt.id
              ? "border-[var(--line-strong)] bg-[var(--paper-2)] text-[var(--ink)]"
              : "border-[var(--line)] text-[var(--ink-2)] hover:bg-[var(--paper-2)] hover:text-[var(--ink)]",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

