"use client";

/**
 * The body of an entity — a person, a customer, a product — in the panel.
 * An entity is mostly what refers to it, so its connections come first:
 * every node that mentions it (Nexo's entity linker adds `references`
 * edges when prose names the entity or one of its aliases), then the
 * aliases themselves, editable as chips (`data.aliases`, the list the
 * linker matches against), then the prose.
 *
 * Alias writes go through the panel's guarded `PATCH data` (optimistic,
 * `if_updated_at`); `data` is written whole, so the patch spreads the
 * node's current data and replaces only `aliases`.
 */

import { useState } from "react";
import { AtSign, Hash, Plus, X } from "lucide-react";
import { Button, Chip } from "@heroui/react";
import { buildConnections, ConnectionsList } from "./connections";
import { PanelProse } from "./prose-body";
import type { PanelBodyProps } from "./panel-body";

/** `entity.data.aliases: string[]` — tolerant of junk, like the linker. */
export function readEntityAliases(data: Record<string, unknown> | null | undefined): string[] {
  const raw = data?.aliases;
  if (!Array.isArray(raw)) return [];
  return raw.filter((alias): alias is string => typeof alias === "string" && alias.trim().length > 0).map((alias) => alias.trim());
}

export function EntityBody(props: PanelBodyProps) {
  const { payload, canWrite, openNode, patchNode, saving } = props;
  const node = payload.node;
  const aliases = readEntityAliases(node.data);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  // Mentions and relations only: a `blocked_by` edge onto an entity would
  // be a modelling mistake, and the list reads better without the label
  // noise of dependencies that cannot exist.
  const connections = buildConnections({ ...payload, dependencies: { blocked_by: [], blocks: [], unblocked: true } });

  const writeAliases = (next: string[]) => patchNode({ data: { ...node.data, aliases: next } });
  const addAlias = () => {
    const alias = draft.trim();
    setDraft("");
    setAdding(false);
    if (!alias || aliases.some((existing) => existing.toLowerCase() === alias.toLowerCase())) return;
    void writeAliases([...aliases, alias]);
  };

  return (
    <div className="flex flex-col gap-5">
      <section aria-label="Mentioned in" data-testid="entity-connections">
        <div className="mono flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.08em] text-[var(--ink-mute)]">
          <AtSign size={11} />
          <span>Mentioned in</span>
          {connections.length > 0 ? <span className="text-[var(--ink-3)]">{connections.length}</span> : null}
        </div>
        <ConnectionsList
          connections={connections}
          onOpen={openNode}
          emptyText="Nothing mentions this entity yet. Name it in another node's prose and Nexo links it here."
        />
      </section>

      <section aria-label="Aliases" data-testid="entity-aliases">
        <div className="mono flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.08em] text-[var(--ink-mute)]">
          <Hash size={11} />
          <span>Aliases</span>
          {canWrite && !adding ? (
            <Button size="sm" variant="ghost" isDisabled={saving} onPress={() => setAdding(true)} className="ml-auto h-6 gap-1 rounded-md px-1.5 text-[11px] normal-case tracking-normal text-[var(--ink-2)]">
              <Plus size={11} /> Add
            </Button>
          ) : null}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {aliases.length === 0 && !adding ? (
            <span className="text-[12px] text-[var(--ink-3)]">No aliases. Other names this entity goes by — a nickname, an acronym — so prose using them links here too.</span>
          ) : null}
          {aliases.map((alias) => (
            <Chip key={alias} size="sm" variant="soft" className="gap-1 pr-1">
              <Chip.Label>{alias}</Chip.Label>
              {canWrite ? (
                <button
                  type="button"
                  aria-label={`Remove alias ${alias}`}
                  disabled={saving}
                  onClick={() => void writeAliases(aliases.filter((item) => item !== alias))}
                  className="rounded-full p-0.5 opacity-50 hover:bg-[var(--paper-3)] hover:opacity-100"
                >
                  <X size={9} />
                </button>
              ) : null}
            </Chip>
          ))}
          {adding ? (
            <input
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={addAlias}
              onKeyDown={(event) => {
                if (event.key === "Enter") addAlias();
                if (event.key === "Escape") { setDraft(""); setAdding(false); }
              }}
              placeholder="Alias"
              aria-label="New alias"
              className="h-6 w-[140px] rounded-full border border-[var(--line)] bg-[var(--paper)] px-2.5 text-[11.5px] text-[var(--ink)] outline-none placeholder:text-[var(--ink-mute)] focus:border-[var(--line-strong)]"
            />
          ) : null}
        </div>
      </section>

      <PanelProse {...props} />
    </div>
  );
}
