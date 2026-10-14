"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import type { Route } from "next";
import { usePathname } from "next/navigation";
import { Sidebar as SidebarPrimitive } from "@/components/ui/sidebar";
import {
  ArrowLeft,
  Bug,
  Building2,
  Gauge,
  Users,
} from "lucide-react";

/**
 * The instance operator's panel, shaped like the product it administers. Mounted by
 * `src/app/admin/layout.tsx` around every `/admin/*` page; `AdminPage`
 * below is what each page body renders into.
 *
 * The app puts its sections in a sidebar and its title in a twelve-pixel
 * header, and two idioms for the same act of navigating is one to learn
 * twice — so this is the workspace shell's ladder with a different set of
 * sections, and it leaves the page bodies free of chrome.
 *
 * It is dark whatever the viewer's theme resolves to. This is one operator's
 * instrument rather than a place customers live in, and half of it rendering
 * light because a component reached for a different token family is worse
 * than either choice made on purpose.
 */

interface AdminSection {
  href: string;
  label: string;
  icon: typeof Gauge;
  /** Overview owns `/admin` itself, so it matches exactly or it matches all. */
  exact?: boolean;
}

const SECTIONS: AdminSection[] = [
  { href: "/admin", label: "Overview", icon: Gauge, exact: true },
  { href: "/admin/orgs", label: "Organizations", icon: Building2 },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/errors", label: "Errors", icon: Bug },
];

/**
 * What the content header is showing. A section knows its own name from the
 * URL; a detail page is the only one that knows the name of the thing it is
 * showing, so it hands that up rather than the shell guessing at an id.
 */
const CrumbContext = createContext<(crumb: string | null) => void>(() => {});

export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "";
  const isCurrent = (href: string, exact?: boolean) =>
    exact ? pathname === href : pathname.startsWith(href);
  const [crumb, setCrumb] = useState<string | null>(null);
  const section = useMemo(() => {
    const match = SECTIONS.filter((s) =>
      s.exact ? pathname === s.href : pathname.startsWith(s.href),
    ).sort((a, b) => b.href.length - a.href.length)[0];
    return match?.label ?? "Admin";
  }, [pathname]);

  return (
    <div className="admin-shell dark flex h-dvh w-full flex-col overflow-hidden bg-[var(--paper)] text-[var(--ink)]">
      <SidebarPrimitive.Provider
        collapsible="offcanvas"
        defaultOpen
        style={{ "--sidebar-width": "232px", "--sidebar-w": "232px" } as React.CSSProperties}
      >
        <SidebarPrimitive className="relative h-full">
          <SidebarPrimitive.Header className="px-3 pt-3">
            <span className="truncate text-[16px] font-semibold tracking-tight">
              Admin panel
            </span>
          </SidebarPrimitive.Header>

          <SidebarPrimitive.Content>
            <nav
              aria-label="Admin sections"
              className="scroll flex-1 overflow-y-auto px-1 pb-3"
            >
              <SidebarPrimitive.Group className="mt-2">
                <SidebarPrimitive.Menu aria-label="Admin sections">
                  {SECTIONS.map(({ href, label, icon: Icon, exact }) => (
                    <SidebarPrimitive.MenuItem
                      key={href}
                      id={href}
                      href={href}
                      isCurrent={isCurrent(href, exact)}
                    >
                      <SidebarPrimitive.MenuIcon>
                        <Icon size={13} />
                      </SidebarPrimitive.MenuIcon>
                      <SidebarPrimitive.MenuItemContent>
                        <SidebarPrimitive.MenuLabel>{label}</SidebarPrimitive.MenuLabel>
                      </SidebarPrimitive.MenuItemContent>
                    </SidebarPrimitive.MenuItem>
                  ))}
                </SidebarPrimitive.Menu>
              </SidebarPrimitive.Group>
            </nav>
          </SidebarPrimitive.Content>

          <SidebarPrimitive.Footer className="p-2">
            <Link
              href={"/workspaces" as Route}
              className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-[var(--ink-2)] transition-colors hover:bg-[var(--paper-3)] hover:text-[var(--ink)]"
            >
              <ArrowLeft size={13} /> Back to the app
            </Link>
          </SidebarPrimitive.Footer>
        </SidebarPrimitive>

        <SidebarPrimitive.Mobile>
          <SidebarPrimitive.Content>
            <nav aria-label="Admin sections" className="px-1 py-3">
              <SidebarPrimitive.Menu aria-label="Admin sections">
                {SECTIONS.map(({ href, label, icon: Icon, exact }) => (
                  <SidebarPrimitive.MenuItem
                    key={href}
                    id={href}
                    href={href}
                    isCurrent={isCurrent(href, exact)}
                  >
                    <SidebarPrimitive.MenuIcon>
                      <Icon size={13} />
                    </SidebarPrimitive.MenuIcon>
                    <SidebarPrimitive.MenuItemContent>
                      <SidebarPrimitive.MenuLabel>{label}</SidebarPrimitive.MenuLabel>
                    </SidebarPrimitive.MenuItemContent>
                  </SidebarPrimitive.MenuItem>
                ))}
              </SidebarPrimitive.Menu>
            </nav>
          </SidebarPrimitive.Content>
        </SidebarPrimitive.Mobile>

        <SidebarPrimitive.Main>
          {/* Where the app puts the workspace's active view: beside the
              control that hides the sidebar, so the eye finds what it is
              looking at in the same place on every screen. */}
          <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-[var(--line)] px-3">
            <SidebarPrimitive.Trigger />
            <span className="truncate text-[13.5px] font-medium text-[var(--ink)]">
              {section}
            </span>
            {crumb ? (
              <>
                <span className="text-[var(--ink-3)]">/</span>
                <span className="truncate text-[13.5px] text-[var(--ink-2)]">
                  {crumb}
                </span>
              </>
            ) : null}
          </div>
          <div className="scroll min-h-0 flex-1 overflow-y-auto">
            <CrumbContext.Provider value={setCrumb}>
              {children}
            </CrumbContext.Provider>
          </div>
        </SidebarPrimitive.Main>
      </SidebarPrimitive.Provider>
    </div>
  );
}

/**
 * A screen's body, and the one action that creates something in it.
 *
 * The name of the screen is not here: it is in the content header beside the
 * sidebar control, where the app puts it, so it stays in one place while the
 * page scrolls. A detail page passes `title` all the same — that is the name
 * of the thing it is showing, and it becomes the crumb after the section.
 */
export function AdminPage({
  title,
  action,
  children,
}: {
  /** Only a detail page needs this: the subject, not the section. */
  title?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const setCrumb = useContext(CrumbContext);
  useEffect(() => {
    setCrumb(title ?? null);
    return () => setCrumb(null);
  }, [setCrumb, title]);

  return (
    <main className="mx-auto w-full max-w-[1080px] px-7 pb-16 pt-6 max-sm:px-4">
      {action ? (
        <header className="mb-5 flex flex-wrap items-center justify-end gap-3">
          {action}
        </header>
      ) : null}
      {children}
    </main>
  );
}
