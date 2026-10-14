"use client";

/**
 * Which Slack channels a Nexo listens to: a searchable multi-select over the
 * channels the install can see (`GET /api/nexos/channels`), with channels
 * another Nexo already owns shown but disabled — one owner per channel, and
 * the API would refuse the claim anyway.
 *
 * Called by the assign dialog of Setup → Sources (a lazily loaded
 * chunk, so none of this weighs on the workspace shell). When the listing is
 * unsupported or fails — a Slack install without the scope, Nango down — it
 * falls back to the typed field the dialog had before: ids or names
 * separated by commas. Nothing selected means the whole install.
 */
import { useEffect, useMemo, useState } from "react";
import { Hash, Lock } from "lucide-react";
import { ListBox, SearchField } from "@heroui/react";
import type { NexoSlackChannel } from "@bcontext-dev/contract/nexos";
import { nexosApi } from "@/lib/nexos/api";
import type { WorkspaceAddress } from "@/web/workspace-url";
import { TextQuestion } from "./nexo-fields";

export interface ChannelSelection {
  ids: string[];
  /** id → name for what was picked from the list, kept on the binding for display. */
  names: Record<string, string>;
}

type Listing = { state: "loading" } | { state: "ready"; channels: NexoSlackChannel[]; truncated: boolean } | { state: "manual" };

export function ChannelPicker({
  workspace,
  installId,
  takenBy,
  onChange,
}: {
  workspace: WorkspaceAddress;
  installId: string;
  /** channel id → name of the other Nexo that owns it. */
  takenBy: Map<string, string>;
  onChange: (selection: ChannelSelection) => void;
}) {
  const [listing, setListing] = useState<Listing>({ state: "loading" });
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [typed, setTyped] = useState("");

  useEffect(() => {
    let cancelled = false;
    nexosApi
      .channels(workspace, installId)
      .then((res) => {
        if (!cancelled) setListing({ state: "ready", channels: res.channels ?? [], truncated: Boolean(res.truncated) });
      })
      .catch(() => {
        if (!cancelled) setListing({ state: "manual" });
      });
    return () => {
      cancelled = true;
    };
  }, [installId, workspace]);

  const channels = listing.state === "ready" ? listing.channels : null;
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase().replace(/^#/, "");
    return (channels ?? []).filter((c) => !needle || c.name.toLowerCase().includes(needle) || c.id.toLowerCase() === needle);
  }, [channels, query]);

  const pick = (next: Set<string>) => {
    setSelected(next);
    const names: Record<string, string> = {};
    for (const c of channels ?? []) if (next.has(c.id)) names[c.id] = c.name;
    onChange({ ids: [...next], names });
  };

  if (listing.state === "manual" || (channels && channels.length === 0)) {
    return (
      <TextQuestion
        label="Channels"
        hint="Channel IDs (C0123ABCD) or names, separated by commas. Leave empty for every channel the app is in."
        value={typed}
        onChange={(value) => {
          setTyped(value);
          const ids = value
            .split(/[\s,]+/)
            .map((c) => c.trim().replace(/^#/, ""))
            .filter(Boolean);
          onChange({ ids, names: {} });
        }}
        placeholder="support, C0123ABCD"
        autoFocus
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-medium text-foreground">Channels</span>
        <span className="text-[11.5px] tabular-nums text-muted">
          {selected.size ? `${selected.size} selected` : "None selected: every channel the app is in"}
        </span>
      </div>
      <SearchField aria-label="Find a channel" value={query} onChange={setQuery} variant="secondary" autoFocus>
        <SearchField.Group>
          <SearchField.SearchIcon />
          <SearchField.Input placeholder="Find a channel" />
          <SearchField.ClearButton />
        </SearchField.Group>
      </SearchField>
      <div className="max-h-[240px] overflow-y-auto rounded-[12px] border border-[var(--line)] bg-[var(--paper)] p-1">
        {!channels ? (
          <p className="m-0 px-3 py-4 text-[12px] text-muted">Loading channels…</p>
        ) : (
          <ListBox
            aria-label="Slack channels"
            selectionMode="multiple"
            selectedKeys={selected}
            disabledKeys={shown.filter((c) => takenBy.has(c.id)).map((c) => c.id)}
            onSelectionChange={(keys) => {
              if (keys === "all") pick(new Set(shown.filter((c) => !takenBy.has(c.id)).map((c) => c.id)));
              else pick(new Set([...keys].map(String)));
            }}
            renderEmptyState={() => <p className="m-0 px-3 py-4 text-[12px] text-muted">No channel matches.</p>}
          >
            {shown.map((channel) => {
              const owner = takenBy.get(channel.id);
              return (
                <ListBox.Item
                  key={channel.id}
                  id={channel.id}
                  textValue={channel.name}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px]"
                >
                  {channel.is_private ? <Lock size={12} className="shrink-0 text-muted" /> : <Hash size={12} className="shrink-0 text-muted" />}
                  <span className="min-w-0 flex-1 truncate">{channel.name}</span>
                  {owner ? (
                    <span className="shrink-0 text-[11px] text-muted">{owner}</span>
                  ) : !channel.is_member ? (
                    <span className="shrink-0 text-[11px] text-muted">invite the app</span>
                  ) : null}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              );
            })}
          </ListBox>
        )}
      </div>
      {listing.state === "ready" && listing.truncated ? (
        <p className="m-0 text-[11.5px] text-muted">Only the first 1,000 channels are listed.</p>
      ) : null}
    </div>
  );
}
