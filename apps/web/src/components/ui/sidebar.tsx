"use client";

/**
 * Sidebar — the app's navigation rail, as a compound component
 * (`Sidebar.Provider/Main/Trigger/Mobile/Header/Content/Footer/Group/
 * GroupLabel/Menu/MenuItem/MenuItemContent/MenuIcon/MenuLabel/MenuChip` and
 * `useSidebar`).
 *
 * Called by the workspace shell (`workspace-shell.tsx` + `sidebar.tsx`), the
 * admin shell (`admin/admin-shell.tsx`) and the organization panel
 * (`workspaces/org-admin/org-admin-modal.tsx`).
 *
 * What must not break:
 * - The class names (`sidebar`, `sidebar__provider`, `sidebar__menu-item`…)
 *   and `data-current` / `data-state` attributes: `sidebar.css` styles them
 *   and `globals.css` hooks into them (the Nexos mark in a row, the
 *   organization panel's rail).
 * - `--sidebar-width` set on the Provider is the rail's width (the workspace
 *   sidebar is user-resizable through it).
 * - Under 768px the desktop aside hides and `Sidebar.Mobile` is a drawer
 *   opened by the same `Sidebar.Trigger`; a link row closes it on press.
 * - `collapsible="offcanvas"` slides the rail away entirely; `"none"` keeps
 *   it fixed (and visible on phones: the organization panel has no drawer).
 *   `mod+b` toggles unless `toggleShortcut={false}`.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import Link from "next/link";
import type { Route } from "next";
import { PanelLeft } from "lucide-react";
import { Button, Drawer } from "@heroui/react";
import { cn } from "@bcontext-dev/contract/utils";

type Collapsible = "offcanvas" | "none";

interface SidebarState {
  collapsible: Collapsible;
  isOpen: boolean;
  isMobile: boolean;
  isMobileOpen: boolean;
  setOpen: (open: boolean) => void;
  setMobileOpen: (open: boolean) => void;
  toggleSidebar: () => void;
}

const SidebarContext = createContext<SidebarState>({
  collapsible: "offcanvas",
  isOpen: true,
  isMobile: false,
  isMobileOpen: false,
  setOpen: () => {},
  setMobileOpen: () => {},
  toggleSidebar: () => {},
});

/** Open/collapsed state of the nearest `Sidebar.Provider`, and the mobile drawer's. */
export function useSidebar() {
  return useContext(SidebarContext);
}

const MOBILE_QUERY = "(max-width: 768px)";

function Provider({
  collapsible = "offcanvas",
  defaultOpen = true,
  open,
  onOpenChange,
  toggleShortcut = true,
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & {
  collapsible?: Collapsible;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** `mod+b` toggles the rail; pass false where another owner has the key. */
  toggleShortcut?: boolean;
  children?: ReactNode;
}) {
  const [ownOpen, setOwnOpen] = useState(defaultOpen);
  const isOpen = open ?? ownOpen;
  const [isMobile, setIsMobile] = useState(false);
  const [isMobileOpen, setMobileOpen] = useState(false);

  const setOpen = useCallback(
    (next: boolean) => {
      onOpenChange?.(next);
      if (open === undefined) setOwnOpen(next);
    },
    [onOpenChange, open],
  );

  const toggleSidebar = useCallback(() => {
    if (collapsible === "none") return;
    if (isMobile) setMobileOpen((value) => !value);
    else setOpen(!isOpen);
  }, [collapsible, isMobile, isOpen, setOpen]);

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    const update = () => {
      setIsMobile(mql.matches);
      if (!mql.matches) setMobileOpen(false);
    };
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!toggleShortcut || collapsible === "none") return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [collapsible, toggleShortcut, toggleSidebar]);

  const value = useMemo(
    () => ({ collapsible, isOpen, isMobile, isMobileOpen, setOpen, setMobileOpen, toggleSidebar }),
    [collapsible, isOpen, isMobile, isMobileOpen, setOpen, toggleSidebar],
  );

  return (
    <SidebarContext.Provider value={value}>
      <div
        data-slot="sidebar-provider"
        data-state={isOpen ? "expanded" : "collapsed"}
        className={cn("sidebar__provider", className)}
        {...rest}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

/** The desktop aside. Offcanvas wraps it so the space it leaves animates to zero. */
function Root({ className, children, ...rest }: HTMLAttributes<HTMLElement>) {
  const { collapsible, isOpen } = useSidebar();
  const state = isOpen ? "expanded" : "collapsed";
  const aside = (
    <aside
      data-slot="sidebar"
      data-state={state}
      data-collapsible={collapsible}
      inert={collapsible === "offcanvas" && !isOpen ? true : undefined}
      className={cn("sidebar", className)}
      {...rest}
    >
      {children}
    </aside>
  );
  if (collapsible !== "offcanvas") return aside;
  return (
    <div className="sidebar__offcanvas-wrapper" data-state={state}>
      {aside}
    </div>
  );
}

function Main({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return <main data-slot="sidebar-main" className={cn("sidebar__main", className)} {...rest} />;
}

/** The toggle: collapses the aside on desktop, opens the drawer on phones. */
function Trigger({ className, children }: { className?: string; children?: ReactNode }) {
  const { toggleSidebar } = useSidebar();
  return (
    <Button
      isIconOnly
      size="sm"
      variant="ghost"
      aria-label="Toggle sidebar"
      data-slot="sidebar-trigger"
      className={className}
      onPress={toggleSidebar}
    >
      {children ?? <PanelLeft className="size-4" />}
    </Button>
  );
}

/** Phone-only drawer from the left; renders nothing on desktop. */
function Mobile({ className, children }: { className?: string; children?: ReactNode }) {
  const { isMobile, isMobileOpen, setMobileOpen } = useSidebar();
  if (!isMobile) return null;
  return (
    <Drawer.Backdrop variant="blur" isOpen={isMobileOpen} onOpenChange={setMobileOpen}>
      <Drawer.Content placement="left">
        <Drawer.Dialog aria-label="Navigation" className="sidebar__mobile-dialog">
          <div data-slot="sidebar-mobile" className={cn("sidebar__mobile", className)}>
            {children}
          </div>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}

function Header({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="sidebar-header" className={cn("sidebar__header", className)} {...rest} />;
}

function Content({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="sidebar-content" className={cn("sidebar__content", className)} {...rest} />;
}

function Footer({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="sidebar-footer" className={cn("sidebar__footer", className)} {...rest} />;
}

function Group({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="sidebar-group" className={cn("sidebar__group", className)} {...rest} />;
}

function GroupLabel({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="sidebar-group-label" className={cn("sidebar__group-label", className)} {...rest} />;
}

function Menu({ className, ...rest }: HTMLAttributes<HTMLUListElement>) {
  return <ul data-slot="sidebar-menu" className={cn("sidebar__menu", className)} {...rest} />;
}

/**
 * One row: a link when it has `href` (client-side navigation; an absolute
 * URL opens in a new tab), a button when it has `onAction`. Everything inside
 * — icon, label, chip, a shortcut hint — lays out in one content row.
 */
function MenuItem({
  id,
  href,
  isCurrent = false,
  onAction,
  textValue,
  className,
  children,
  "aria-label": ariaLabel,
  "aria-keyshortcuts": ariaKeyShortcuts,
}: {
  id?: string;
  href?: string;
  isCurrent?: boolean;
  onAction?: () => void;
  /** Accessible name when the row's content is not plain text. */
  textValue?: string;
  className?: string;
  children?: ReactNode;
  "aria-label"?: string;
  "aria-keyshortcuts"?: string;
}) {
  const { isMobile, setMobileOpen } = useSidebar();
  const rowClass = cn("sidebar__menu-item", className);
  const content = <div data-slot="sidebar-menu-item-content" className="sidebar__menu-item-content">{children}</div>;
  const common = {
    id,
    "data-slot": "sidebar-menu-item",
    "data-current": isCurrent ? "true" : undefined,
    "aria-current": isCurrent ? ("page" as const) : undefined,
    "aria-label": ariaLabel ?? textValue,
    "aria-keyshortcuts": ariaKeyShortcuts,
    className: rowClass,
  };

  let row: ReactNode;
  if (href) {
    const external = /^https?:\/\//.test(href);
    const onClick = (event: MouseEvent) => {
      onAction?.();
      if (isMobile && !event.defaultPrevented) setMobileOpen(false);
    };
    row = external ? (
      <a {...common} href={href} target="_blank" rel="noopener noreferrer" onClick={onClick}>
        {content}
      </a>
    ) : (
      <Link {...common} href={href as Route} onClick={onClick}>
        {content}
      </Link>
    );
  } else {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onAction?.();
      }
    };
    // A div, not a <button>: rows may carry a <kbd> hint and must lay out
    // exactly like the link rows.
    row = (
      <div {...common} role="button" tabIndex={0} onClick={onAction} onKeyDown={onKeyDown}>
        {content}
      </div>
    );
  }
  return <li className="contents">{row}</li>;
}

/** Grouping marker kept for call-site readability; its children join the row. */
function MenuItemContent({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

function MenuIcon({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span data-slot="sidebar-menu-icon" className={cn("sidebar__menu-icon", className)} {...rest} />;
}

function MenuLabel({ className, children, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span data-slot="sidebar-menu-label" data-sidebar="label" className={cn("sidebar__menu-label", className)} {...rest}>
      <span className="sidebar__menu-label-text">{children}</span>
    </span>
  );
}

function MenuChip({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span data-slot="sidebar-menu-chip" className={cn("sidebar__menu-chip", className)} {...rest} />;
}

export const Sidebar = Object.assign(Root, {
  Provider,
  Main,
  Trigger,
  Mobile,
  Header,
  Content,
  Footer,
  Group,
  GroupLabel,
  Menu,
  MenuItem,
  MenuItemContent,
  MenuIcon,
  MenuLabel,
  MenuChip,
});
