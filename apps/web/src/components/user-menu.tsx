"use client";

import { useRef, useState } from "react";
import {
  Activity as ActivityIcon,
  ChevronsUpDown,
  LogOut,
  Settings as SettingsIcon,
  UserRound,
  Sparkles,
} from "lucide-react";
import { Dropdown, Header, Label, Separator, Skeleton } from "@heroui/react";
import dynamic from "next/dynamic";
import { displayName } from "@bcontext-dev/contract/me";
import { clearAllLocalSettings } from "@/lib/local-settings";
import { forgetMe, useMe } from "@/hooks/use-me";
import { PersonAvatar } from "./person-avatar";
import { ThemeSwitcher } from "./theme-switcher";

// Only rendered while open — load it on demand instead of shipping it with
// the sidebar chrome.
const AccountModal = dynamic(() => import("./account-modal").then((m) => m.AccountModal));

/**
 * Account menu — avatar + dropdown with Profile, Activity and Settings (when
 * scoped to a workspace), theme toggle, and sign-out. Lives in the workspace
 * sidebar footer and in the /workspaces top nav, and is the same component
 * in both places on purpose: two account menus that look different are two
 * products.
 *
 * It says the person's name, from the account (`GET /api/me` via `useMe`),
 * with the email as the second line, where an identifier belongs. That name
 * arrives one request after the first paint, and the fallback for "nobody
 * yet" is the word "You" — fine as a resting state and awful as a flash. So
 * the first paint is a skeleton instead: a shape in the right place, rather
 * than a wrong answer that corrects itself half a second later.
 *
 * `onOpenSettings` and `onOpenActivity` are optional so the menu can render
 * outside a workspace (e.g. on /workspaces) without depending on
 * `WorkspaceProvider`; the corresponding item is hidden when the prop is
 * omitted. Activity is here, not in the sidebar, on purpose.
 *
 * `align` controls where the dropdown anchors. The sidebar footer wants it
 * above the trigger ("up"); the /workspaces top nav wants it below ("down").
 *
 * Sign-out clears every local setting and the cached `me` first, so the next
 * person on this browser does not inherit a name or a density.
 */
export function UserMenu({
  onOpenSettings,
  onOpenActivity,
  onOpenGuide,
  align = "up",
  profileCard = false,
}: {
  onOpenSettings?: () => void;
  /** Navigate to the workspace Activity feed; hidden when omitted. */
  onOpenActivity?: () => void;
  /** Bring the "Getting started" guide back; hidden when omitted. */
  onOpenGuide?: () => void;
  align?: "up" | "down";
  /** Demo-style footer row: large round avatar + name and email stacked. */
  profileCard?: boolean;
} = {}) {
  const [accountOpen, setAccountOpen] = useState(false);
  const { me, loading } = useMe();
  const signOutFormRef = useRef<HTMLFormElement>(null);

  const email = me?.user.email ?? null;
  const primaryLine = displayName(me?.user);
  // Only when it adds something: for an account with no name yet the primary
  // line is already the address's local part, and repeating it underneath is
  // noise dressed as detail.
  const secondaryLine = email && email !== primaryLine ? email : null;

  function handleAction(key: React.Key) {
    if (key === "account") {
      setAccountOpen(true);
    } else if (key === "settings") {
      onOpenSettings?.();
    } else if (key === "activity") {
      onOpenActivity?.();
    } else if (key === "guide") {
      onOpenGuide?.();
    } else if (key === "signout") {
      clearAllLocalSettings();
      forgetMe();
      signOutFormRef.current?.requestSubmit();
    }
  }

  return (
    <div className="relative">
      <Dropdown>
        {profileCard ? (
          <Dropdown.Trigger
            aria-label="User menu"
            className="avatar-wake flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-[var(--paper-2)] outline-none ring-0 data-[focus-visible]:ring-0 data-[focus-visible]:outline-none"
          >
            <PersonAvatar user={me?.user} size={32} pending={loading} animate="hover" />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              {loading ? (
                <>
                  <Skeleton className="h-[11px] w-24 rounded" />
                  <Skeleton className="h-[9px] w-32 rounded" />
                </>
              ) : (
                <>
                  <span className="truncate text-[12.5px] font-medium leading-tight text-foreground">
                    {primaryLine}
                  </span>
                  {secondaryLine ? (
                    <span className="truncate text-[11px] leading-tight text-muted">{secondaryLine}</span>
                  ) : null}
                </>
              )}
            </span>
            <ChevronsUpDown size={13} className="shrink-0 text-muted" />
          </Dropdown.Trigger>
        ) : (
        <Dropdown.Trigger
          aria-label="User menu"
          className="avatar-wake flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-[var(--bg-muted)]"
        >
          <PersonAvatar user={me?.user} size={24} pending={loading} animate="hover" />
          {loading ? (
            <Skeleton className="h-[10px] min-w-0 flex-1 rounded" />
          ) : (
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--fg)]">
              {primaryLine}
            </span>
          )}
          <ChevronsUpDown
            size={12}
            className="shrink-0 text-[var(--fg-subtle)]"
          />
        </Dropdown.Trigger>
        )}
        <Dropdown.Popover
          placement={align === "up" ? "top" : "bottom end"}
          className="w-[var(--trigger-width)] min-w-[248px] rounded-xl p-1.5 fade-in outline-none ring-0 data-[focus-visible]:ring-0 data-[focus-visible]:outline-none"
        >
          {/* Demo-style panel: avatar header, airy items with right-edge
              icons, danger sign-out — spacing instead of hard separators. */}
          <Dropdown.Menu aria-label="User options" onAction={handleAction} className="outline-none ring-0 data-[focus-visible]:ring-0 data-[focus-visible]:outline-none">
            <Dropdown.Section>
              <Header>
                <div className="flex items-center gap-3 px-2.5 pb-2 pt-2">
                  <PersonAvatar user={me?.user} size={36} pending={loading} animate="always" />
                  <div className="flex min-w-0 flex-col gap-0.5">
                    {loading ? (
                      <>
                        <Skeleton className="h-[12px] w-28 rounded" />
                        <Skeleton className="h-[10px] w-36 rounded" />
                      </>
                    ) : (
                      <>
                        <span className="truncate text-[13px] font-medium text-foreground">{primaryLine}</span>
                        {secondaryLine ? (
                          <span className="truncate text-[11.5px] text-muted">{secondaryLine}</span>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>
              </Header>
            </Dropdown.Section>
            <Dropdown.Section>
              <Dropdown.Item
                id="account"
                textValue="Profile"
                className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-[var(--ink-2)] hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
              >
                <Label>Profile</Label>
                <UserRound size={14} className="ml-auto text-muted" />
              </Dropdown.Item>
              {onOpenActivity && (
                <Dropdown.Item
                  id="activity"
                  textValue="Activity"
                  className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-[var(--ink-2)] hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
                >
                  <Label>Activity</Label>
                  <ActivityIcon size={14} className="ml-auto text-muted" />
                </Dropdown.Item>
              )}
              {onOpenGuide && (
                <Dropdown.Item
                  id="guide"
                  textValue="Getting started"
                  className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-[var(--ink-2)] hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
                >
                  <Label>Getting started</Label>
                  <Sparkles size={14} className="ml-auto text-muted" />
                </Dropdown.Item>
              )}
              {onOpenSettings && (
                <Dropdown.Item
                  id="settings"
                  textValue="Settings"
                  className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-[var(--ink-2)] hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
                >
                  <Label>Settings</Label>
                  <SettingsIcon size={14} className="ml-auto text-muted" />
                </Dropdown.Item>
              )}
              <Dropdown.Item
                id="signout"
                textValue="Log out"
                className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-danger hover:bg-[var(--paper-2)]"
              >
                <Label>Log out</Label>
                <LogOut size={14} className="ml-auto" />
              </Dropdown.Item>
            </Dropdown.Section>
          </Dropdown.Menu>
          <Separator className="my-1" />
          <div className="flex items-center justify-between px-2.5 py-1.5">
            <span className="text-[11.5px] text-muted">Theme</span>
            <ThemeSwitcher />
          </div>
        </Dropdown.Popover>
      </Dropdown>

      <form ref={signOutFormRef} action="/auth/signout" method="post" className="hidden" />

      {accountOpen && <AccountModal onClose={() => setAccountOpen(false)} />}
    </div>
  );
}
