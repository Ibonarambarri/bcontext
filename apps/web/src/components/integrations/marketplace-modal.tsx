"use client";

/**
 * "Add integration" — the marketplace. Tabs by category (Popular first),
 * a search field, and a grid of provider cards. Connect hands the entry
 * back to the hub, which knows how to drive each `via` (native flows keep
 * their own modals/redirects; Nango providers open the Connect UI).
 * `coming_soon` cards are shown dimmed with no action. OAuth providers follow
 * the hybrid model: with a shared Bcontext app (`setup: ready`) Connect just
 * authorises; without one (`setup: needs_oauth_app`) the card carries a
 * "Your own app" chip and Connect asks the hub for the own-app flow, where
 * the workspace pastes its OAuth client id + secret. Cards with a shared
 * app still offer "Use your own OAuth app instead".
 */
import { useEffect, useMemo, useState } from "react";
import { Check, KeyRound, Loader2, Sparkles } from "lucide-react";
import { Button, Chip, Modal, SearchField, Tabs, Tooltip } from "@heroui/react";
import { EmptyState } from "@/components/ui/empty-state";
import { ProviderLogo } from "./provider-logo";
import { canUseOwnApp, filterCatalog, MARKETPLACE_TABS, NATIVE_CATALOG, needsOwnApp } from "@/lib/integrations/catalog";
import { CATEGORY_LABELS, type IntegrationCatalogEntry } from "@/lib/integrations/types";
import { cn } from "@bcontext-dev/contract/utils";

type TabId = (typeof MARKETPLACE_TABS)[number]["id"];

export interface ConnectOptions {
  /** Connect through the workspace's own OAuth app (hybrid OAuth flow). */
  ownApp?: boolean;
}

export function MarketplaceModal({
  open,
  onClose,
  connectedKeys,
  connecting,
  onConnect,
}: {
  open: boolean;
  onClose: () => void;
  /** connector_ids already installed (not uninstalled). */
  connectedKeys: ReadonlySet<string>;
  /** connector_id currently mid-connect (spinner on its card). */
  connecting: string | null;
  onConnect: (entry: IntegrationCatalogEntry, options?: ConnectOptions) => void;
}) {
  const [entries, setEntries] = useState<IntegrationCatalogEntry[] | null>(null);
  const [tab, setTab] = useState<TabId>("popular");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/integrations/catalog", { cache: "no-store" });
        const body = (await r.json().catch(() => ({}))) as { entries?: IntegrationCatalogEntry[] };
        if (!cancelled) setEntries(r.ok && body.entries?.length ? body.entries : NATIVE_CATALOG);
      } catch {
        if (!cancelled) setEntries(NATIVE_CATALOG);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const visible = useMemo(() => (entries ? filterCatalog(entries, tab, query) : []), [entries, tab, query]);
  // A search spans every category — the tab only scopes when nothing is typed.
  const searching = query.trim().length > 0;
  const results = useMemo(
    () => (searching && entries ? filterCatalog(entries, "all", query) : visible),
    [searching, entries, query, visible],
  );

  return (
    <>
      <Modal.Backdrop
        isOpen={open}
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
      >
        <Modal.Container size="lg" scroll="inside">
          {/* Wide on purpose: the grid needs four columns to keep names,
              chips and descriptions readable. Header (title, search, tabs)
              stays put; only the grid scrolls. */}
          <Modal.Dialog
            aria-label="Add integration"
            className="w-[min(96vw,1180px)] max-w-none sm:max-w-[1180px] max-h-[86dvh]"
          >
            <Modal.CloseTrigger />
            <Modal.Header className="gap-3 pb-1">
              <div>
                <Modal.Heading className="text-[16px] font-medium">Add integration</Modal.Heading>
                <p className="m-0 mt-0.5 text-[12px] leading-[1.5] text-[var(--ink-3)]">
                  Connect a source and tell your Nexos what to learn from it. The brain grows on its own from there.
                </p>
              </div>
              <SearchField value={query} onChange={setQuery} aria-label="Search integrations" className="w-full">
                <SearchField.Group className="h-9 rounded-md border border-[var(--line)] bg-[var(--paper-2)]">
                  <SearchField.SearchIcon />
                  <SearchField.Input placeholder="Search by name…" className="text-[12.5px]" />
                  <SearchField.ClearButton />
                </SearchField.Group>
              </SearchField>
              <Tabs selectedKey={tab} onSelectionChange={(key) => setTab(key as TabId)} className="w-full">
                <Tabs.ListContainer
                  className={cn(
                    "scroll w-full overflow-x-auto rounded-none bg-transparent [scrollbar-width:thin]",
                    searching ? "opacity-50" : "",
                  )}
                >
                  <Tabs.List aria-label="Integration categories" className="w-max gap-1 bg-transparent p-0">
                    {MARKETPLACE_TABS.map((t) => (
                      <Tabs.Tab key={t.id} id={t.id} className="h-7 whitespace-nowrap px-2.5 text-[12px]">
                        {t.label}
                        <Tabs.Indicator />
                      </Tabs.Tab>
                    ))}
                  </Tabs.List>
                </Tabs.ListContainer>
              </Tabs>
            </Modal.Header>

            <Modal.Body className="flex flex-col gap-3 pt-2">
              {entries === null ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-busy="true">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className="h-[132px] animate-pulse rounded-[12px] border border-[var(--line)] bg-[var(--paper-2)]" />
                  ))}
                </div>
              ) : results.length === 0 ? (
                <EmptyState className="min-h-[220px] rounded-[12px] border border-dashed border-[var(--line)] bg-[var(--paper-2)] px-6 py-10">
                  <EmptyState.Header>
                    <EmptyState.Media variant="icon">
                      <Sparkles size={16} />
                    </EmptyState.Media>
                    <EmptyState.Title className="text-[14px]">Nothing matches</EmptyState.Title>
                    <EmptyState.Description className="max-w-[360px]">
                      Try another name or category.
                    </EmptyState.Description>
                  </EmptyState.Header>
                </EmptyState>
              ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {results.map((entry) => (
                    <ProviderCard
                      key={entry.key}
                      entry={entry}
                      connected={connectedKeys.has(entry.key)}
                      connecting={connecting === entry.key}
                      onConnect={() => onConnect(entry, needsOwnApp(entry) ? { ownApp: true } : undefined)}
                      onConnectOwnApp={() => onConnect(entry, { ownApp: true })}
                    />
                  ))}
                </div>
              )}
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  );
}

function ProviderCard({
  entry,
  connected,
  connecting,
  onConnect,
  onConnectOwnApp,
}: {
  entry: IntegrationCatalogEntry;
  connected: boolean;
  connecting: boolean;
  onConnect: () => void;
  onConnectOwnApp: () => void;
}) {
  const soon = entry.status === "coming_soon";
  const ownApp = needsOwnApp(entry);
  // A shared app exists, so "Connect" just authorises — but the workspace may
  // still prefer its own OAuth app (own console, own revocation).
  const ownAppOptional = !ownApp && canUseOwnApp(entry) && !connected && !soon;
  return (
    <article
      title={entry.name}
      className={cn(
        "flex h-full min-h-[132px] flex-col gap-2.5 rounded-[12px] border border-[var(--line)] bg-[var(--paper)] p-3.5 transition-colors",
        soon ? "opacity-70" : "hover:border-[var(--ink-mute)]",
      )}
    >
      {/* Header: logo, then a column — the name alone on its line (so a
          chip never squeezes it into "G…"), chips as whole units below. */}
      <div className="flex items-start gap-3">
        <ProviderLogo name={entry.name} logoUrl={entry.logo_url} connectorId={entry.key} size={36} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 className="m-0 truncate text-[14px] font-medium leading-tight text-[var(--ink)]" title={entry.name}>
            {entry.name}
          </h3>
          <div className="flex flex-wrap items-center gap-1">
            <Chip size="sm" variant="soft" className="h-5 shrink-0 whitespace-nowrap px-1.5 text-[10px]">
              {CATEGORY_LABELS[entry.category]}
            </Chip>
            {ownApp && !connected ? (
              <Tooltip delay={300}>
                <Tooltip.Trigger>
                  <Chip size="sm" variant="soft" className="h-5 shrink-0 gap-1 whitespace-nowrap px-1.5 text-[10px]">
                    <KeyRound size={9} className="shrink-0" /> Your own app
                  </Chip>
                </Tooltip.Trigger>
                <Tooltip.Content>Connect with your organisation&apos;s OAuth app</Tooltip.Content>
              </Tooltip>
            ) : null}
          </div>
        </div>
      </div>

      <p className="m-0 line-clamp-2 min-h-[2.9em] text-[12.5px] leading-[1.45] text-[var(--ink-3)]">{entry.description}</p>

      {/* Actions pinned to the bottom so buttons line up across the row;
          the own-app alternative sits under Connect as a quiet second line. */}
      <div className="mt-auto flex flex-col items-end gap-1">
        {connected ? (
          <Chip size="sm" variant="soft" color="success" className="gap-1 whitespace-nowrap">
            <Check size={11} /> Connected
          </Chip>
        ) : soon ? (
          <Chip size="sm" variant="soft" className="whitespace-nowrap">
            Coming soon
          </Chip>
        ) : (
          <Button size="sm" variant="outline" isDisabled={connecting} onPress={onConnect} className="h-7 gap-1.5 text-[11.5px]">
            {connecting ? <Loader2 size={11} className="animate-spin" /> : null}
            {connecting ? "Connecting…" : "Connect"}
          </Button>
        )}
        {ownAppOptional ? (
          <Button
            size="sm"
            variant="ghost"
            isDisabled={connecting}
            onPress={onConnectOwnApp}
            className="h-6 min-w-0 whitespace-nowrap px-1 text-[11px] font-normal text-[var(--ink-3)] hover:text-[var(--ink)]"
          >
            Use your own OAuth app instead
          </Button>
        ) : null}
      </div>
    </article>
  );
}
