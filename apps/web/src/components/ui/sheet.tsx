"use client";

/**
 * Sheet — a panel that slides in from a screen edge over a backdrop. Used by
 * the admin "New organization" form and the graph's "Manage tags" panel.
 *
 * A thin layer over HeroUI's Drawer that keeps the call-site shape the app
 * was written against: `placement` on the root, and sizing classes on
 * `Sheet.Content`. HeroUI's `Drawer.Content` is the full-viewport positioning
 * box — a width there anchors the panel to the wrong side — so this moves
 * Content's classes onto the Dialog, the panel itself. The side the panel
 * sits on gets the rounded corners, the screen edge stays square.
 */
import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import { Drawer } from "@heroui/react";
import { cn } from "@bcontext-dev/contract/utils";

type Placement = "top" | "bottom" | "left" | "right";

const SheetContext = createContext<{ placement: Placement; contentClassName?: string }>({ placement: "right" });

const ROUNDED: Record<Placement, string> = {
  right: "rounded-l-[calc(var(--radius)*2)] max-w-[96vw]",
  left: "rounded-r-[calc(var(--radius)*2)] max-w-[96vw]",
  top: "rounded-b-[calc(var(--radius)*2)] max-h-[96vh]",
  bottom: "rounded-t-[calc(var(--radius)*2)] max-h-[96vh]",
};

function Root({
  placement = "bottom",
  isOpen,
  onOpenChange,
  children,
}: {
  placement?: Placement;
  isOpen?: boolean;
  onOpenChange?: (isOpen: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <SheetContext.Provider value={{ placement }}>
      <Drawer isOpen={isOpen} onOpenChange={onOpenChange}>
        {children}
      </Drawer>
    </SheetContext.Provider>
  );
}

function Backdrop({ className, ...rest }: ComponentProps<typeof Drawer.Backdrop>) {
  return <Drawer.Backdrop className={className} {...rest} />;
}

/** Positions the panel; its `className` sizes the panel (see the header). */
function Content({ className, children }: { className?: string; children?: ReactNode }) {
  const { placement } = useContext(SheetContext);
  return (
    <SheetContext.Provider value={{ placement, contentClassName: className }}>
      <Drawer.Content placement={placement}>{children}</Drawer.Content>
    </SheetContext.Provider>
  );
}

function Dialog({ className, ...rest }: ComponentProps<typeof Drawer.Dialog>) {
  const { placement, contentClassName } = useContext(SheetContext);
  return (
    <Drawer.Dialog
      className={cn("w-auto p-0 sm:w-auto", ROUNDED[placement], contentClassName, typeof className === "string" ? className : undefined)}
      {...rest}
    />
  );
}

function Header({ className, ...rest }: ComponentProps<"div">) {
  return <div data-slot="sheet-header" className={cn("flex shrink-0 flex-col gap-1 px-5 pb-2 pt-4", className)} {...rest} />;
}

function Heading({ className, ...rest }: ComponentProps<typeof Drawer.Heading>) {
  return <Drawer.Heading className={cn("text-base font-semibold text-foreground", className)} {...rest} />;
}

function Body({ className, ...rest }: ComponentProps<"div">) {
  return <div data-slot="sheet-body" className={cn("flex-auto overflow-y-auto px-5 py-2", className)} {...rest} />;
}

function CloseTrigger({ className }: { className?: string }) {
  return <Drawer.CloseTrigger className={cn("static text-muted hover:text-foreground", className)} />;
}

export const Sheet = Object.assign(Root, { Backdrop, Content, Dialog, Header, Heading, Body, CloseTrigger });
