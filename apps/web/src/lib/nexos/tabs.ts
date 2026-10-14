/**
 * Which tab (and Setup section) a Nexo's page opens for a `?tab=` /
 * `?section=` query. Called by `nexo-detail.tsx`; kept out of
 * `view-shell.ts` because the workspace shell imports that one and pays for
 * every byte of it.
 *
 * The page once had Integrations, Tools and Settings tabs; links in sent
 * escalation emails and bookmarks still carry them, so they open Setup at
 * the section each became. Unknown values open the chat.
 */
import { NEXO_TABS, type NexoSetupSection, type NexoTab } from "@/lib/view-shell";

export const NEXO_SETUP_SECTIONS: readonly NexoSetupSection[] = [
  "sources",
  "abilities",
  "behaviour",
  "escalation",
  "instructions",
  "budget",
  "danger",
];

const RETIRED_TABS: Readonly<Record<string, NexoSetupSection>> = {
  integrations: "sources",
  tools: "abilities",
  settings: "behaviour",
};

export function resolveNexoTab(tab: string | null, section: string | null): { tab: NexoTab; section: NexoSetupSection | null } {
  const retired = tab && Object.prototype.hasOwnProperty.call(RETIRED_TABS, tab) ? RETIRED_TABS[tab] : undefined;
  if (retired) return { tab: "setup", section: retired };
  const known = (NEXO_TABS as readonly string[]).includes(tab ?? "") ? (tab as NexoTab) : "chat";
  const wanted = (NEXO_SETUP_SECTIONS as readonly string[]).includes(section ?? "") ? (section as NexoSetupSection) : null;
  return { tab: known, section: known === "setup" ? wanted : null };
}
