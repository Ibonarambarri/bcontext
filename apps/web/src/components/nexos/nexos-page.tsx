"use client";

/**
 * Nexos — the workspace's team, mounted by `app/w/[org]/[ws]/nexos/page.tsx`.
 *
 * The team: a grid of cards (the general Nexo first, then every
 * specialist), the "New Nexo" card, and up to two faint suggestion cards that
 * start the wizard on a template nobody has used yet. Connected agents and
 * tool providers are not here: they keep views of their own (`v/agents`,
 * `v/tools`), so this page stays about the team.
 *
 * There is no workspace-level "Add integration": an integration always
 * belongs to a Nexo and is connected from that Nexo's page. The general
 * Nexo's card carries the guide's `integrations-add` anchor — it owns
 * whatever nobody else claims, so it is where a first source goes.
 *
 * Data: `GET /api/nexos` (via `useNexos`); a new Nexo is created by the
 * wizard and appears at once, before the list is read again.
 */
import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button, Chip } from "@heroui/react";
import { cn } from "@bcontext-dev/contract/utils";
import { GridSkeleton } from "@/components/skeletons";
import { ProviderLogo } from "@/components/integrations/provider-logo";
import { NATIVE_CATALOG } from "@/lib/integrations/catalog";
import { NEXO_TEMPLATES, type NexoListItem, type NexoTemplate } from "@bcontext-dev/contract/nexos";
import { nexoDetailPath } from "@/lib/view-shell";
import type { WorkspaceAddress } from "@/web/workspace-url";
import { AUTONOMY_COPY } from "./nexo-copy";
import { NexoFace } from "./nexo-face";
import { sortNexos, useNexos } from "./use-nexos";

const CreateNexoWizard = dynamic(() => import("./create-nexo-wizard").then((m) => m.CreateNexoWizard));

/** How many faint "start from a template" cards the grid may offer. */
const MAX_SUGGESTIONS = 2;

export function NexosPage({ workspace }: { workspace: WorkspaceAddress }) {
  const router = useRouter();
  const { nexos, setNexos, error } = useNexos(workspace);
  const [wizard, setWizard] = useState<{ template: string | null } | null>(null);

  const suggestions = useMemo(() => {
    if (!nexos) return [];
    const used = new Set(nexos.map((n) => n.template));
    const names = new Set(nexos.map((n) => n.name.trim().toLowerCase()));
    return NEXO_TEMPLATES.filter(
      (t) =>
        t.key !== "custom" &&
        !used.has(t.key) &&
        !names.has(t.name.toLowerCase()) &&
        !names.has(t.en.name.toLowerCase()),
    ).slice(0, MAX_SUGGESTIONS);
  }, [nexos]);

  return (
    <div className="scroll h-full overflow-y-auto bg-[var(--paper)]">
      <div className="mx-auto max-w-[1080px] px-5 pb-20 pt-9 sm:px-8 xl:px-12">
        <section aria-labelledby="nexos-team">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-0 max-w-[560px]">
              <h2 id="nexos-team" className="m-0 text-[15px] font-medium">
                Your team
              </h2>
              <p className="mt-0.5 text-[12px] leading-[1.55] text-[var(--ink-3)]">
                Each Nexo looks after one part of the work: it listens to its sources, keeps the brain
                current and comes to you when it is not sure.
              </p>
            </div>
            <span className="ml-auto" />
            <Button size="sm" className="gap-1.5" onPress={() => setWizard({ template: null })}>
              <Plus size={14} />
              New Nexo
            </Button>
          </div>

          {error && !nexos ? (
            <div role="alert" className="mt-5 rounded-[12px] border border-[var(--line)] bg-[var(--paper-2)] p-4 text-[12.5px] text-[var(--ink-2)]">
              Couldn&apos;t load the Nexos: {error}
            </div>
          ) : !nexos ? (
            <GridSkeleton cards={3} minHeightClassName="min-h-[188px]" label="Loading Nexos" />
          ) : (
            <ul className="mt-5 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 xl:grid-cols-3">
              {nexos.map((nexo) => (
                <li key={nexo.id} className="min-w-0">
                  <NexoCard
                    nexo={nexo}
                    href={nexoDetailPath(workspace, nexo.is_general ? "general" : nexo.id)}
                    tourAnchor={nexo.is_general ? "integrations-add" : undefined}
                  />
                </li>
              ))}
              <li className="min-w-0">
                <NewNexoCard onPress={() => setWizard({ template: null })} />
              </li>
              {suggestions.map((template) => (
                <li key={template.key} className="min-w-0">
                  <SuggestionCard template={template} onPress={() => setWizard({ template: template.key })} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {wizard ? (
        <CreateNexoWizard
          workspace={workspace}
          initialTemplate={wizard.template}
          onClose={() => setWizard(null)}
          onCreated={(nexo) => {
            setNexos((current) => sortNexos([...(current ?? []), { ...nexo, open_inbox_count: 0, integrations: [], bindings: [] }]));
          }}
          onOpen={(nexo) => {
            setWizard(null);
            router.push(nexoDetailPath(workspace, nexo.id));
          }}
        />
      ) : null}
    </div>
  );
}

/** Height every card in the grid shares, so a row never goes ragged. */
const CARD = "flex h-full min-h-[188px] w-full flex-col rounded-[14px] p-4 text-left";

function NexoCard({
  nexo,
  href,
  tourAnchor,
}: {
  nexo: NexoListItem;
  href: ReturnType<typeof nexoDetailPath>;
  tourAnchor?: string;
}) {
  const paused = nexo.status === "paused";
  const waiting = nexo.open_inbox_count ?? 0;
  const connectors = nexo.integrations ?? [];
  return (
    <Link
      href={href}
      data-tour={tourAnchor}
      className={cn(
        CARD,
        "avatar-wake group relative border border-[var(--line)] bg-[var(--paper)] no-underline transition-[border-color,background-color] duration-150 hover:border-[var(--ink-mute)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
      )}
    >
      <div className="flex items-start gap-3">
        <NexoFace name={nexo.name} general={nexo.is_general} size={48} animate="hover" muted={paused} />
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex items-center gap-2">
            <h3 className="m-0 truncate text-[14.5px] font-medium leading-tight text-[var(--ink)]">{nexo.name}</h3>
            {nexo.is_general ? (
              <Chip size="sm" variant="soft" className="shrink-0">
                General
              </Chip>
            ) : null}
          </div>
          <p className="m-0 mt-1 flex items-center gap-1.5 text-[11.5px] text-[var(--ink-3)]">
            <StatusDot paused={paused} />
            {paused ? "Paused" : AUTONOMY_COPY[nexo.autonomy].short}
          </p>
        </div>
        {waiting > 0 ? (
          <Chip size="sm" variant="soft" color="accent" className="absolute right-3 top-3 tabular-nums">
            {waiting} waiting
          </Chip>
        ) : null}
      </div>

      <p
        className={cn(
          "m-0 mt-3 line-clamp-2 text-[12.5px] leading-[1.5]",
          nexo.description ? "text-[var(--ink-2)]" : "italic text-[var(--ink-mute)]",
        )}
      >
        {nexo.description ||
          (nexo.is_general ? "Answers from the whole workspace and catches whatever no specialist owns." : "No description yet.")}
      </p>

      <div className="mt-auto flex items-center gap-2 pt-4">
        {connectors.length ? (
          <div className="flex items-center -space-x-1.5">
            {connectors.slice(0, 4).map((key) => {
              const entry = NATIVE_CATALOG.find((e) => e.key === key);
              return (
                <ProviderLogo
                  key={key}
                  name={entry?.name ?? key}
                  logoUrl={entry?.logo_url}
                  connectorId={key}
                  size={24}
                  className="rounded-[7px] ring-2 ring-[var(--paper)]"
                />
              );
            })}
            {connectors.length > 4 ? (
              <span className="pl-2.5 text-[11px] tabular-nums text-[var(--ink-3)]">+{connectors.length - 4}</span>
            ) : null}
          </div>
        ) : (
          <span className="text-[11.5px] text-[var(--ink-mute)]">
            {nexo.is_general ? "Listens to unassigned sources" : "No sources yet"}
          </span>
        )}
      </div>
    </Link>
  );
}

function StatusDot({ paused }: { paused: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn("h-1.5 w-1.5 shrink-0 rounded-full", paused ? "bg-[var(--ink-mute)]" : "bg-[var(--accent)]")}
    />
  );
}

/** The always-there card that opens the wizard on a blank template. */
function NewNexoCard({ onPress }: { onPress: () => void }) {
  return (
    <button
      type="button"
      onClick={onPress}
      className={cn(
        CARD,
        "cursor-[var(--cursor-interactive)] items-center justify-center gap-2 border border-dashed border-[var(--line-strong)] bg-transparent text-[var(--ink-3)] transition-colors duration-150 hover:border-[var(--ink-mute)] hover:bg-[var(--paper-2)] hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
      )}
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-full border border-dashed border-current">
        <Plus size={18} />
      </span>
      <span className="text-[13px] font-medium">New Nexo</span>
      <span className="max-w-[220px] text-center text-[11.5px] leading-[1.5] text-[var(--ink-mute)]">
        Answer a few questions and it starts working.
      </span>
    </button>
  );
}

/**
 * A template nobody has used yet, offered as a suggestion: a dashed outline
 * says "not on the team yet", but the text is full strength — it is an
 * invitation, not a disabled card. One click opens the wizard on its
 * questions, prefilled.
 */
function SuggestionCard({ template: preset, onPress }: { template: NexoTemplate; onPress: () => void }) {
  const template = preset.en;
  return (
    <button
      type="button"
      onClick={onPress}
      aria-label={`Set up a ${template.name} Nexo`}
      className={cn(
        CARD,
        "avatar-wake group cursor-[var(--cursor-interactive)] border border-dashed border-[var(--line-strong)] bg-transparent transition-[border-color,background-color,transform] duration-150 ease-out hover:border-[var(--ink-mute)] hover:bg-[var(--paper-2)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] active:scale-[0.99]",
      )}
    >
      <div className="flex items-start gap-3">
        <NexoFace name={template.name} size={48} animate="hover" />
        <div className="min-w-0 flex-1 pt-0.5">
          <h3 className="m-0 truncate text-[14.5px] font-medium leading-tight text-[var(--ink)]">{template.name}</h3>
          <p className="m-0 mt-1 text-[11.5px] text-[var(--ink-3)]">Suggested</p>
        </div>
      </div>
      <p className="m-0 mt-3 line-clamp-2 text-[12.5px] leading-[1.5] text-[var(--ink-2)]">{template.description}</p>
      <span className="mt-auto flex items-center gap-1 pt-4 text-[12px] font-medium text-[var(--ink)]">
        <Plus size={12} />
        Set up {template.name}
      </span>
    </button>
  );
}
