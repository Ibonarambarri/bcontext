"use client";

/**
 * Setup → Sources: what a Nexo listens to, and the one way to give it more.
 *
 * A binding is an install plus a scope (for Slack, the channels) and a mode —
 * listen, or listen and reply. One owner per install and scope: the API
 * refuses a second claim and says who has it. Anything nobody claims goes to
 * the general Nexo.
 *
 * "Connect a source" opens a short dialog: the workspace's
 * connected apps, each with "Use for <Nexo>", and "Connect a new app" — the
 * popular few plus search, the full catalog one link further. Picking one
 * opens the assign dialog (channels, mode). A native OAuth hop leaves the
 * app, so before it we remember this page (`lib/nexos/connect-return.ts`);
 * the launcher brings the person back here with `?connect=<connector>` and
 * the assign dialog opens on the fresh install.
 *
 * Below, collapsed, the workspace's connected apps themselves (the hub:
 * configure, run now, disconnect, meeting records).
 *
 * Data: the detail's bindings, `POST /api/nexos/:id/bindings`,
 * `DELETE …/bindings/:bindingId`, the list (`GET /api/nexos`) to name who
 * owns what, installs from `GET /api/connectors`, the catalog from
 * `GET /api/integrations/catalog`. Removing is optimistic and unconfirmed:
 * nothing is lost, the source falls back to the general Nexo.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";
import { ArrowLeft, Hash, Plus, Trash2 } from "lucide-react";
import { Button, Chip, Disclosure, Modal, SearchField, Tooltip } from "@heroui/react";
import { RadioButtonGroup } from "@/components/ui/button-groups";
import { useConnectorInstall } from "@/components/integrations/integrations-hub";
import { ProviderLogo } from "@/components/integrations/provider-logo";
import { useToast } from "@/components/workspace-context";
import { filterCatalog, NATIVE_CATALOG } from "@/lib/integrations/catalog";
import type { ConnectorInstall, IntegrationCatalogEntry } from "@/lib/integrations/types";
import type { NexoBinding, NexoBindingMode } from "@bcontext-dev/contract/nexos";
import { nexosApi, type NexoView } from "@/lib/nexos/api";
import { rememberConnectReturn } from "@/lib/nexos/connect-return";
import { nexoDetailPath } from "@/lib/view-shell";
import { workspaceApiRef, type WorkspaceAddress } from "@/web/workspace-url";
import { ChannelPicker, type ChannelSelection } from "./nexo-channel-picker";

// Both only matter once opened: the hub polls, the marketplace is a big grid.
const IntegrationsHub = dynamic(() => import("@/components/integrations/integrations-hub").then((m) => m.IntegrationsHub));
const MarketplaceModal = dynamic(() => import("@/components/integrations/marketplace-modal").then((m) => m.MarketplaceModal));

/** Shown first under "Connect a new app"; the rest are a search away. */
const POPULAR_COUNT = 6;
/** Meeting records has its own setup flow; it is managed in the hub, never "listened to". */
const NOT_A_SOURCE = "meeting-bot";

function connectorName(key: string, catalog?: Map<string, IntegrationCatalogEntry>): string {
  return (
    catalog?.get(key)?.name ??
    NATIVE_CATALOG.find((e) => e.key === key)?.name ??
    key.charAt(0).toUpperCase() + key.slice(1)
  );
}

function connectorLogo(key: string, catalog?: Map<string, IntegrationCatalogEntry>): string | null {
  return catalog?.get(key)?.logo_url ?? NATIVE_CATALOG.find((e) => e.key === key)?.logo_url ?? null;
}

/** What `scope_key` says about a binding: the channel it covers, or null for the whole install. */
function channelOf(binding: Pick<NexoBinding, "scope_key">): string | null {
  return binding.scope_key.startsWith("channel:") ? binding.scope_key.slice("channel:".length) : null;
}

/** The name the picker stored for a channel, else the id as typed. */
function channelLabel(binding: NexoBinding, channel: string): string {
  const names = binding.scope?.channel_names;
  const name = names && typeof names === "object" ? (names as Record<string, unknown>)[channel] : undefined;
  return typeof name === "string" ? name : channel;
}

/** Both ways Slack arrives: the first-party app and the Nango-backed install. */
function isSlackConnector(connectorId: string): boolean {
  return connectorId === "slack" || connectorId === "slack-nango";
}

/** Who else owns what: install id → Nexo name, and per install channel id → Nexo name. */
interface Owners {
  installs: Map<string, string>;
  channels: Map<string, Map<string, string>>;
}

/** The install-level rows: one per install, its channels gathered. */
interface SourceGroup {
  installId: string;
  connectorId: string;
  mode: NexoBindingMode;
  channels: string[];
  bindings: NexoBinding[];
}

function groupByInstall(bindings: NexoBinding[]): SourceGroup[] {
  const groups = new Map<string, SourceGroup>();
  for (const binding of bindings) {
    const group = groups.get(binding.install_id) ?? {
      installId: binding.install_id,
      connectorId: binding.connector_id,
      mode: binding.mode,
      channels: [],
      bindings: [],
    };
    const channel = channelOf(binding);
    if (channel) group.channels.push(channelLabel(binding, channel));
    if (binding.mode === "listen_reply") group.mode = "listen_reply";
    group.bindings.push(binding);
    groups.set(binding.install_id, group);
  }
  return [...groups.values()];
}

export function NexoSources({
  workspace,
  nexo,
  onBindingsChange,
}: {
  workspace: WorkspaceAddress;
  nexo: NexoView;
  onBindingsChange: (bindings: NexoBinding[]) => void;
}) {
  const toast = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [bindings, setBindingsState] = useState<NexoBinding[]>(nexo.bindings ?? []);
  const [owners, setOwners] = useState<Owners>({ installs: new Map(), channels: new Map() });
  const [installs, setInstalls] = useState<ConnectorInstall[] | null>(null);
  const [catalog, setCatalog] = useState<Map<string, IntegrationCatalogEntry>>(
    () => new Map(NATIVE_CATALOG.map((entry) => [entry.key, entry])),
  );
  const [connectOpen, setConnectOpen] = useState(false);
  const [assigning, setAssigning] = useState<ConnectorInstall | null>(null);
  const [pendingConnect, setPendingConnect] = useState<string | null>(params.get("connect"));

  const setBindings = useCallback(
    (next: NexoBinding[]) => {
      setBindingsState(next);
      onBindingsChange(next);
    },
    [onBindingsChange],
  );

  const loadInstalls = useCallback(async () => {
    try {
      const r = await fetch(`/api/connectors?workspace=${encodeURIComponent(workspaceApiRef(workspace))}`, { cache: "no-store" });
      const body = (await r.json().catch(() => ({}))) as { installs?: ConnectorInstall[] };
      const list = (body.installs ?? []).filter((i) => i.status !== "uninstalled" && i.connector_id !== NOT_A_SOURCE);
      setInstalls(list);
      return list;
    } catch {
      setInstalls([]);
      return [];
    }
  }, [workspace]);

  useEffect(() => {
    let cancelled = false;
    void loadInstalls();
    fetch("/api/integrations/catalog", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { entries: [] }))
      .then((body: { entries?: IntegrationCatalogEntry[] }) => {
        if (cancelled || !body.entries?.length) return;
        setCatalog((prev) => {
          const next = new Map(prev);
          for (const entry of body.entries!) next.set(entry.key, entry);
          return next;
        });
      })
      .catch(() => {
        // The native entries are already there.
      });
    // This Nexo's own bindings came with the detail; the list only names the others.
    nexosApi
      .list(workspace)
      .then((list) => {
        if (cancelled) return;
        const next: Owners = { installs: new Map(), channels: new Map() };
        for (const other of list) {
          if (other.id === nexo.id) continue;
          for (const b of other.bindings ?? []) {
            next.installs.set(b.install_id, other.name);
            const channel = channelOf(b);
            if (!channel) continue;
            const perInstall = next.channels.get(b.install_id) ?? new Map<string, string>();
            perInstall.set(channel, other.name);
            next.channels.set(b.install_id, perInstall);
          }
        }
        setOwners(next);
      })
      .catch(() => {
        // Owners' names are a nicety.
      });
    return () => {
      cancelled = true;
    };
  }, [loadInstalls, nexo.id, workspace]);

  const here = useMemo(() => new Set(bindings.map((b) => b.install_id)), [bindings]);

  /** Drop `connect` from the URL once handled, so a reload does not reopen anything. */
  const clearQuery = useCallback(() => {
    const query = new URLSearchParams(params.toString());
    if (!query.has("connect")) return;
    query.delete("connect");
    const suffix = query.toString();
    router.replace(`${pathname}${suffix ? `?${suffix}` : ""}` as Route, { scroll: false });
  }, [params, pathname, router]);

  // Back from an OAuth hop: hand the fresh install over, or show the list
  // when it did not come through.
  useEffect(() => {
    if (!pendingConnect || !installs) return;
    const fresh = installs.find((i) => i.connector_id === pendingConnect && !here.has(i.id));
    setPendingConnect(null);
    clearQuery();
    if (fresh && !nexo.is_general) setAssigning(fresh);
    else if (fresh) toast.info(`${connectorName(fresh.connector_id, catalog)} connected. ${nexo.name} listens to it.`);
    else setConnectOpen(true);
  }, [catalog, clearQuery, here, installs, nexo.is_general, nexo.name, pendingConnect, toast]);

  const remove = async (group: SourceGroup) => {
    const before = bindings;
    const gone = new Set(group.bindings.map((b) => b.id));
    setBindings(bindings.filter((b) => !gone.has(b.id)));
    try {
      await Promise.all(group.bindings.map((b) => nexosApi.unbind(workspace, nexo.id, b.id)));
      toast.info(
        nexo.is_general
          ? `${connectorName(group.connectorId, catalog)} removed.`
          : `${connectorName(group.connectorId, catalog)} goes back to the general Nexo.`,
      );
    } catch (e) {
      setBindings(before);
      toast.error(`Couldn't remove it: ${(e as Error).message}`);
    }
  };

  const selfRef = nexo.is_general ? "general" : nexo.id;
  const connector = useConnectorInstall({
    onInstalled: useCallback(
      async (install: ConnectorInstall) => {
        await loadInstalls();
        setConnectOpen(false);
        if (!nexo.is_general) setAssigning(install);
      },
      [loadInstalls, nexo.is_general],
    ),
    beforeRedirect: useCallback(
      (entry: IntegrationCatalogEntry) =>
        rememberConnectReturn(
          `${nexoDetailPath(workspace, selfRef, { tab: "setup", section: "sources" })}&connect=${encodeURIComponent(entry.key)}`,
        ),
      [selfRef, workspace],
    ),
  });

  return (
    <div className="flex flex-col gap-4">
      {bindings.length === 0 ? (
        <div className="rounded-[14px] border border-dashed border-[var(--line)] bg-[var(--paper-2)] px-4 py-5 text-[12.5px] text-[var(--ink-3)]">
          {nexo.is_general
            ? "No sources of its own: it hears whatever no other Nexo has claimed."
            : `Nothing yet. Connect a source and ${nexo.name} starts listening.`}
        </div>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {groupByInstall(bindings).map((group) => (
            <SourceRow
              key={group.installId}
              group={group}
              name={connectorName(group.connectorId, catalog)}
              logo={connectorLogo(group.connectorId, catalog)}
              onRemove={() => void remove(group)}
            />
          ))}
        </ul>
      )}

      <div>
        <Button size="sm" variant="outline" className="gap-1.5" onPress={() => setConnectOpen(true)}>
          <Plus size={13} />
          Connect a source
        </Button>
      </div>

      <Disclosure>
        <Disclosure.Heading>
          <Button slot="trigger" variant="ghost" size="sm" className="-ml-2 gap-1.5 text-[12.5px] text-muted">
            Manage the workspace&apos;s connected apps
            <Disclosure.Indicator />
          </Button>
        </Disclosure.Heading>
        <Disclosure.Content>
          <Disclosure.Body className="pt-3">
            <IntegrationsHub workspace={workspace} />
          </Disclosure.Body>
        </Disclosure.Content>
      </Disclosure>

      {connectOpen ? (
        <ConnectSourceDialog
          nexo={nexo}
          installs={installs}
          catalog={catalog}
          here={here}
          owners={owners}
          connecting={connector.connecting}
          onClose={() => {
            setConnectOpen(false);
            clearQuery();
          }}
          onUse={(install) => {
            setConnectOpen(false);
            setAssigning(install);
          }}
          onConnect={(entry, ownApp) => void connector.connect(entry, ownApp ? { ownApp: true } : undefined)}
        />
      ) : null}
      {connector.ownAppModal}

      {assigning ? (
        <AssignDialog
          workspace={workspace}
          install={assigning}
          name={connectorName(assigning.connector_id, catalog)}
          logo={connectorLogo(assigning.connector_id, catalog)}
          nexo={nexo}
          takenBy={owners.channels.get(assigning.id) ?? new Map()}
          onClose={() => setAssigning(null)}
          onAssign={async (input) => {
            const created = await nexosApi.bind(workspace, nexo.id, { install_id: assigning.id, ...input });
            setBindings([...bindings.filter((b) => b.install_id !== assigning.id), ...created]);
            toast.info(`${nexo.name} now listens to ${connectorName(assigning.connector_id, catalog)}.`);
            setAssigning(null);
          }}
        />
      ) : null}
    </div>
  );
}

function SourceRow({
  group,
  name,
  logo,
  onRemove,
}: {
  group: SourceGroup;
  name: string;
  logo: string | null;
  onRemove: () => void;
}) {
  return (
    <li className="flex items-center gap-3 rounded-[12px] border border-[var(--line)] bg-[var(--paper)] px-4 py-3">
      <ProviderLogo name={name} logoUrl={logo} connectorId={group.connectorId} size={32} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-[13.5px] font-medium text-foreground">{name}</span>
          <Chip size="sm" variant="soft">
            {group.mode === "listen_reply" ? "Listens and replies" : "Listens"}
          </Chip>
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {group.channels.length ? (
            group.channels.map((channel) => (
              <span key={channel} className="mono inline-flex max-w-full items-center gap-0.5 truncate rounded-full bg-[var(--paper-2)] px-2 py-0.5 text-[10.5px] text-[var(--ink-2)]">
                <Hash size={9} className="shrink-0" />
                {channel.replace(/^#/, "")}
              </span>
            ))
          ) : (
            <span className="text-[11.5px] text-[var(--ink-3)]">Everything from this source</span>
          )}
        </div>
      </div>
      <Tooltip delay={400}>
        <Button isIconOnly size="sm" variant="ghost" aria-label={`Stop listening to ${name}`} onPress={onRemove}>
          <Trash2 size={14} />
        </Button>
        <Tooltip.Content>Stop listening</Tooltip.Content>
      </Tooltip>
    </li>
  );
}

/**
 * Two short lists in one dialog. First the apps this workspace already
 * connected (most of the time the answer is there); then, one press away,
 * a new app: the popular few, or search the catalog.
 */
function ConnectSourceDialog({
  nexo,
  installs,
  catalog,
  here,
  owners,
  connecting,
  onClose,
  onUse,
  onConnect,
}: {
  nexo: NexoView;
  installs: ConnectorInstall[] | null;
  catalog: Map<string, IntegrationCatalogEntry>;
  here: Set<string>;
  owners: Owners;
  connecting: string | null;
  onClose: () => void;
  onUse: (install: ConnectorInstall) => void;
  onConnect: (entry: IntegrationCatalogEntry, ownApp?: boolean) => void;
}) {
  const hasInstalls = (installs?.length ?? 0) > 0;
  const [step, setStep] = useState<"connected" | "new">(installs && !hasInstalls ? "new" : "connected");
  const [query, setQuery] = useState("");
  const [browseAll, setBrowseAll] = useState(false);

  // An empty workspace has nothing to pick from: go straight to new apps.
  useEffect(() => {
    if (installs && !hasInstalls) setStep("new");
  }, [hasInstalls, installs]);

  const installedKeys = useMemo(() => new Set((installs ?? []).map((i) => i.connector_id)), [installs]);
  const entries = useMemo(() => [...catalog.values()].filter((e) => e.key !== NOT_A_SOURCE), [catalog]);
  const shown = useMemo(
    () =>
      query.trim()
        ? filterCatalog(entries, "all", query).slice(0, 8)
        : filterCatalog(entries, "all", "")
            .filter((e) => e.status === "available")
            .slice(0, POPULAR_COUNT),
    [entries, query],
  );

  const useLabel = `Use for ${nexo.name}`;

  return (
    <>
      <Modal.Backdrop isOpen onOpenChange={(open) => (!open ? onClose() : undefined)}>
        <Modal.Container size="md" scroll="inside">
          <Modal.Dialog aria-label="Connect a source" className="sm:max-w-[520px]">
            <Modal.Header className="gap-1">
              <div className="flex items-center gap-2">
                {step === "new" && hasInstalls ? (
                  <Tooltip delay={400}>
                    <Button isIconOnly size="sm" variant="ghost" aria-label="Back to connected apps" onPress={() => setStep("connected")}>
                      <ArrowLeft size={14} />
                    </Button>
                    <Tooltip.Content>Back to connected apps</Tooltip.Content>
                  </Tooltip>
                ) : null}
                <Modal.Heading>{step === "connected" ? "Connect a source" : "Connect a new app"}</Modal.Heading>
              </div>
              <p className="m-0 text-[12.5px] text-muted">
                {step === "connected"
                  ? `Pick what ${nexo.name} should listen to.`
                  : `After connecting, you choose what ${nexo.name} listens to there.`}
              </p>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-3">
              {step === "connected" ? (
                installs === null ? (
                  <p className="m-0 py-4 text-[12.5px] text-muted">Loading connected apps…</p>
                ) : (
                  <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                    {installs.map((install) => {
                      const isHere = here.has(install.id);
                      const owner = owners.installs.get(install.id);
                      const name = connectorName(install.connector_id, catalog);
                      return (
                        <li key={install.id} className="flex items-center gap-3 rounded-[12px] border border-[var(--line)] px-3 py-2.5">
                          <ProviderLogo name={name} logoUrl={connectorLogo(install.connector_id, catalog)} connectorId={install.connector_id} size={28} />
                          <div className="min-w-0 flex-1">
                            <p className="m-0 truncate text-[13px] font-medium text-foreground">{name}</p>
                            <p className="m-0 truncate text-[11.5px] text-muted">
                              {isHere ? `${nexo.name} listens to it` : owner ? `${owner} listens to some of it` : "Nobody has it yet"}
                            </p>
                          </div>
                          <Button size="sm" variant={isHere ? "ghost" : "outline"} className="shrink-0" onPress={() => onUse(install)}>
                            {isHere ? "Change" : useLabel}
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                )
              ) : (
                <>
                  <SearchField aria-label="Search apps" value={query} onChange={setQuery} variant="secondary" autoFocus>
                    <SearchField.Group>
                      <SearchField.SearchIcon />
                      <SearchField.Input placeholder="Search apps" />
                      <SearchField.ClearButton />
                    </SearchField.Group>
                  </SearchField>
                  {!query.trim() ? <p className="m-0 text-[11.5px] text-muted">Popular</p> : null}
                  {shown.length === 0 ? (
                    <p className="m-0 py-3 text-[12.5px] text-muted">Nothing matches “{query.trim()}”.</p>
                  ) : (
                    <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                      {shown.map((entry) => {
                        const installed = installs?.find((i) => i.connector_id === entry.key) ?? null;
                        const soon = entry.status !== "available";
                        return (
                          <li key={entry.key} className="flex items-center gap-3 rounded-[12px] border border-[var(--line)] px-3 py-2.5">
                            <ProviderLogo name={entry.name} logoUrl={entry.logo_url} connectorId={entry.key} size={28} />
                            <div className="min-w-0 flex-1">
                              <p className="m-0 truncate text-[13px] font-medium text-foreground">{entry.name}</p>
                              <p className="m-0 line-clamp-1 text-[11.5px] text-muted">{entry.description}</p>
                            </div>
                            {installed ? (
                              <Button size="sm" variant="outline" className="shrink-0" onPress={() => onUse(installed)}>
                                {useLabel}
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                className="shrink-0"
                                isDisabled={soon}
                                isPending={connecting === entry.key}
                                onPress={() => onConnect(entry)}
                              >
                                {soon ? "Soon" : "Connect"}
                              </Button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </>
              )}
            </Modal.Body>
            <Modal.Footer className="justify-between">
              {step === "connected" ? (
                <Button variant="ghost" className="gap-1.5" onPress={() => setStep("new")}>
                  <Plus size={13} />
                  Connect a new app
                </Button>
              ) : (
                <Button variant="ghost" onPress={() => setBrowseAll(true)}>
                  Browse all apps
                </Button>
              )}
              <Button variant="secondary" onPress={onClose}>
                Close
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
      {browseAll ? (
        <MarketplaceModal
          open
          onClose={() => setBrowseAll(false)}
          connectedKeys={installedKeys}
          connecting={connecting}
          onConnect={(entry, options) => {
            const installed = installs?.find((i) => i.connector_id === entry.key);
            setBrowseAll(false);
            if (installed) onUse(installed);
            else onConnect(entry, options?.ownApp);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Giving a source to this Nexo: which part of it (Slack: channels) and
 * whether it may answer there. Replying is offered only when its autonomy
 * lets it write to anyone at all.
 */
function AssignDialog({
  workspace,
  install,
  name,
  logo,
  nexo,
  takenBy,
  onClose,
  onAssign,
}: {
  workspace: WorkspaceAddress;
  install: ConnectorInstall;
  name: string;
  logo: string | null;
  nexo: NexoView;
  takenBy: Map<string, string>;
  onClose: () => void;
  onAssign: (input: { channels: string[]; mode: NexoBindingMode; scope?: Record<string, unknown> }) => Promise<void>;
}) {
  const isSlack = isSlackConnector(install.connector_id);
  const canReply = nexo.autonomy !== "observe";
  const [channels, setChannels] = useState<ChannelSelection>({ ids: [], names: {} });
  const [mode, setMode] = useState<NexoBindingMode>(canReply ? "listen_reply" : "listen");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      await onAssign(
        isSlack
          ? {
              channels: channels.ids,
              mode,
              ...(Object.keys(channels.names).length ? { scope: { channel_names: channels.names } } : {}),
            }
          : { channels: [], mode },
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal.Backdrop isOpen onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <Modal.Container size="md" scroll="inside">
        <Modal.Dialog aria-label={`Use ${name} for ${nexo.name}`} className="sm:max-w-[480px]">
          <Modal.Header className="gap-1">
            <div className="flex items-center gap-3">
              <ProviderLogo name={name} logoUrl={logo} connectorId={install.connector_id} size={36} />
              <div className="min-w-0">
                <Modal.Heading>
                  Use {name} for {nexo.name}
                </Modal.Heading>
                <p className="m-0 text-[12.5px] text-muted">It reads what arrives here and acts within its autonomy.</p>
              </div>
            </div>
          </Modal.Header>
          <Modal.Body className="flex flex-col gap-5">
            {isSlack ? <ChannelPicker workspace={workspace} installId={install.id} takenBy={takenBy} onChange={setChannels} /> : null}
            <RadioButtonGroup
              aria-label="What it may do there"
              value={mode}
              onChange={(next) => setMode(next as NexoBindingMode)}
              layout="grid"
              className="grid grid-cols-1 gap-2"
            >
              <RadioButtonGroup.Item value="listen" className="items-start rounded-xl p-3">
                <RadioButtonGroup.Indicator />
                <RadioButtonGroup.ItemContent className="gap-0.5">
                  <span className="text-[13px] font-medium text-foreground">Listen</span>
                  <span className="text-[11.5px] text-muted">Learns from it and tells you when something needs a person.</span>
                </RadioButtonGroup.ItemContent>
              </RadioButtonGroup.Item>
              <RadioButtonGroup.Item value="listen_reply" isDisabled={!canReply} className="items-start rounded-xl p-3">
                <RadioButtonGroup.Indicator />
                <RadioButtonGroup.ItemContent className="gap-0.5">
                  <span className="text-[13px] font-medium text-foreground">Listen and reply</span>
                  <span className="text-[11.5px] text-muted">
                    {canReply
                      ? nexo.autonomy === "draft"
                        ? "Replies go to the inbox as drafts for you to approve."
                        : "Replies directly in the thread."
                      : "It only observes, so it never writes to anyone. Change that under How it works."}
                  </span>
                </RadioButtonGroup.ItemContent>
              </RadioButtonGroup.Item>
            </RadioButtonGroup>
            {error ? (
              <p role="alert" className="m-0 text-[12.5px] text-danger">
                {error}
              </p>
            ) : null}
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" onPress={onClose}>
              Cancel
            </Button>
            <Button onPress={() => void submit()} isPending={pending}>
              Use for {nexo.name}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
