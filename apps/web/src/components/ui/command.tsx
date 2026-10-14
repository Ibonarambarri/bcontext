"use client";

/**
 * Command — the ⌘K palette primitive: a modal with a search field on top of a
 * filtered, keyboard-navigable list. Used by `command-palette.tsx`.
 *
 * Built straight on React Aria: `Autocomplete` wires the `SearchField` to the
 * `Menu` below it, so arrow keys move a virtual focus through the items while
 * the caret stays in the input, Enter fires the menu's `onAction`, and Esc
 * closes the overlay. `Command.Dialog` takes `filter`, `inputValue` and
 * `onInputChange`; pass `filter={() => true}` when the caller ranks results
 * itself (the palette does) so React Aria does not filter them a second time.
 *
 * Plain typing must never reach global shortcuts, so the input stops the
 * propagation of single printable keys (with no modifier) at capture time.
 */
import { createContext, useContext, type HTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import {
  Autocomplete,
  Dialog,
  Header,
  Input,
  Menu,
  MenuItem,
  MenuSection,
  Modal,
  ModalOverlay,
  SearchField,
  useFilter,
  type AutocompleteProps,
  type DialogProps,
  type InputProps,
  type MenuItemProps,
  type MenuProps,
  type ModalOverlayProps,
  type SearchFieldProps,
} from "react-aria-components";
import { cn } from "@bcontext-dev/contract/utils";

type CommandSize = "sm" | "md" | "lg";

const SizeContext = createContext<CommandSize>("md");

const DIALOG_SIZE: Record<CommandSize, string> = {
  sm: "max-w-sm max-h-[min(80vh,300px)]",
  md: "max-w-lg max-h-[min(80vh,356px)]",
  lg: "max-w-xl max-h-[min(80vh,440px)]",
};

/** Kept for API symmetry with the compound parts; renders its children as is. */
function Root({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

/**
 * The full-screen overlay. The tint is set inline from `--ov-backdrop` (the
 * same token the settings dialog uses) because the theme's overlay colours
 * barely differ from the page in dark mode.
 */
function Backdrop({
  className,
  variant = "opaque",
  isDismissable = true,
  style,
  ...rest
}: Omit<ModalOverlayProps, "className"> & { className?: string; variant?: "blur" | "opaque" | "transparent" }) {
  return (
    <ModalOverlay
      data-slot="command-backdrop"
      isDismissable={isDismissable}
      className={cn(
        "fixed inset-0 z-50 flex h-[var(--visual-viewport-height,100dvh)] w-full items-start justify-center",
        "transition-opacity duration-150 ease-out data-[entering]:opacity-0 data-[exiting]:opacity-0 data-[exiting]:duration-100 motion-reduce:transition-none",
        variant === "blur" && "backdrop-blur-md",
        className,
      )}
      style={variant === "transparent" ? style : { background: "var(--ov-backdrop, rgba(0,0,0,0.55))", ...style }}
      {...rest}
    />
  );
}

function Container({
  className,
  size = "md",
  children,
}: {
  className?: string;
  size?: CommandSize;
  children?: ReactNode;
}) {
  return (
    <SizeContext.Provider value={size}>
      <Modal
        data-slot="command-container"
        className={cn(
          "pointer-events-none flex h-[var(--visual-viewport-height,100dvh)] w-full items-start justify-center px-4 pt-[15vh]",
          "transition-[opacity,transform] duration-200 ease-[cubic-bezier(.25,.46,.45,.94)] data-[entering]:-translate-y-2 data-[entering]:scale-95 data-[entering]:opacity-0",
          "data-[exiting]:scale-95 data-[exiting]:opacity-0 data-[exiting]:duration-100 motion-reduce:transition-none",
          className,
        )}
      >
        {children}
      </Modal>
    </SizeContext.Provider>
  );
}

function CommandDialog({
  className,
  children,
  filter,
  inputValue,
  defaultInputValue,
  onInputChange,
  ...rest
}: Omit<DialogProps, "children" | "className"> & { className?: string } &
  Pick<AutocompleteProps<object>, "filter" | "inputValue" | "defaultInputValue" | "onInputChange"> & { children?: ReactNode }) {
  const size = useContext(SizeContext);
  const { contains } = useFilter({ sensitivity: "base" });
  return (
    <Dialog
      aria-label="Command palette"
      data-slot="command-dialog"
      className={cn(
        "pointer-events-auto relative flex w-full flex-col overflow-hidden rounded-[calc(var(--radius)*2)] bg-overlay shadow-[var(--overlay-shadow)] outline-none",
        DIALOG_SIZE[size],
        className,
      )}
      {...rest}
    >
      <Autocomplete
        filter={filter ?? contains}
        inputValue={inputValue}
        defaultInputValue={defaultInputValue}
        onInputChange={onInputChange}
      >
        {children}
      </Autocomplete>
    </Dialog>
  );
}

function InputGroupRoot({ className, autoFocus = true, ...rest }: Omit<SearchFieldProps, "className"> & { className?: string }) {
  return (
    <SearchField
      aria-label={rest["aria-label"] ?? "Search commands"}
      autoFocus={autoFocus}
      data-slot="command-input-group"
      className={cn("group/command-input flex w-full items-center gap-2 border-b border-[color-mix(in_oklab,var(--border)_70%,transparent)]", className)}
      {...rest}
    />
  );
}

function InputGroupPrefix({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="command-input-group-prefix"
      className={cn("flex shrink-0 items-center ps-4 text-muted [:where(&)_svg]:size-4", className)}
      {...rest}
    />
  );
}

function InputGroupSuffix({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="command-input-group-suffix"
      className={cn("flex shrink-0 items-center pe-4 text-muted [:where(&)_svg]:size-4", className)}
      {...rest}
    />
  );
}

function InputGroupInput({ className, placeholder = "Search commands...", onKeyDownCapture, ...rest }: Omit<InputProps, "className"> & { className?: string }) {
  return (
    <Input
      data-slot="command-input-group-input"
      placeholder={placeholder}
      className={cn(
        "min-w-0 flex-1 bg-transparent px-4 py-3 text-sm text-foreground outline-none placeholder:text-muted",
        "[&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none",
        "group-has-[[data-slot=command-input-group-prefix]]/command-input:ps-0 group-has-[[data-slot=command-input-group-suffix]]/command-input:pe-0",
        className,
      )}
      onKeyDownCapture={(event: KeyboardEvent<HTMLInputElement>) => {
        onKeyDownCapture?.(event);
        if (!event.defaultPrevented && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.stopPropagation();
        }
      }}
      {...rest}
    />
  );
}

const InputGroup = Object.assign(InputGroupRoot, {
  Prefix: InputGroupPrefix,
  Suffix: InputGroupSuffix,
  Input: InputGroupInput,
});

function List<T extends object>({ className, renderEmptyState, ...rest }: Omit<MenuProps<T>, "className"> & { className?: string }) {
  return (
    <Menu<T>
      data-slot="command-list"
      className={cn("flex-1 overflow-y-auto overscroll-contain p-1.5 outline-none", className)}
      renderEmptyState={
        renderEmptyState
          ? () => (
              <div data-slot="command-empty" className="flex h-full items-center justify-center py-6 text-center text-sm text-muted">
                {renderEmptyState()}
              </div>
            )
          : undefined
      }
      {...rest}
    />
  );
}

function Group({ className, heading, children }: { className?: string; heading?: ReactNode; children?: ReactNode }) {
  return (
    <MenuSection data-slot="command-group" className={cn("[&+&]:mt-1", className)}>
      {heading ? (
        <Header data-slot="command-group-heading" className="select-none px-3 py-1.5 text-xs font-medium text-muted">
          {heading}
        </Header>
      ) : null}
      {children}
    </MenuSection>
  );
}

function Item({ className, ...rest }: Omit<MenuItemProps, "className"> & { className?: string }) {
  return (
    <MenuItem
      data-slot="command-item"
      className={cn(
        "relative flex cursor-pointer select-none items-center gap-2.5 rounded-[var(--radius)] px-3 py-2 text-sm text-foreground outline-none",
        "data-[focused]:bg-default data-[pressed]:bg-default-hover [@media(hover:hover)]:data-[hovered]:bg-default",
        "data-[disabled]:cursor-default data-[disabled]:opacity-50",
        "[:where(&)_svg]:size-4 [:where(&)_svg]:shrink-0 [:where(&)_svg]:text-muted [&_kbd]:ms-auto [&_kbd]:text-xs [&_kbd]:text-muted",
        className,
      )}
      {...rest}
    />
  );
}

function Footer({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="command-footer"
      className={cn(
        "flex w-full items-center gap-2 border-t border-[color-mix(in_oklab,var(--border)_50%,transparent)] bg-[color-mix(in_oklab,var(--default)_50%,transparent)] px-3 py-1 text-xs text-muted",
        className,
      )}
      {...rest}
    />
  );
}

export const Command = Object.assign(Root, {
  Backdrop,
  Container,
  Dialog: CommandDialog,
  InputGroup,
  List,
  Group,
  Item,
  Footer,
});

