"use client";

/**
 * DropZone — a dashed "drop a file here, or choose one" target, used by
 * `data-node-view.tsx` to take a CSV for a dataset.
 *
 * `DropZone.Area` is React Aria's `DropZone` (drag-and-drop, keyboard and
 * screen-reader drops, `data-drop-target` while hovering). The file picker is
 * a hidden `<input type="file">` (`DropZone.Input`) that `DropZone.Trigger`
 * clicks through context, so both paths end in the caller's handlers. The
 * input's value is reset after each pick so choosing the same file twice
 * still fires.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ChangeEvent,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Button as AriaButton,
  DropZone as AriaDropZone,
  Text,
  type ButtonProps as AriaButtonProps,
  type DropZoneProps as AriaDropZoneProps,
} from "react-aria-components";
import { CloudUpload } from "lucide-react";
import { cn } from "@bcontext-dev/contract/utils";

interface DropZoneContextValue {
  inputRef: RefObject<HTMLInputElement | null>;
  openFilePicker: () => void;
}

const DropZoneContext = createContext<DropZoneContextValue | null>(null);

function useDropZone() {
  const context = useContext(DropZoneContext);
  if (!context) throw new Error("DropZone parts must render inside <DropZone>");
  return context;
}

function Root({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const openFilePicker = useCallback(() => inputRef.current?.click(), []);
  const value = useMemo(() => ({ inputRef, openFilePicker }), [openFilePicker]);
  return (
    <DropZoneContext.Provider value={value}>
      <div data-slot="drop-zone" className={cn("flex flex-col gap-3", className)} {...rest} />
    </DropZoneContext.Provider>
  );
}

function Area({ className, children, ...rest }: Omit<AriaDropZoneProps, "className" | "children"> & { className?: string; children?: ReactNode }) {
  return (
    <AriaDropZone
      data-slot="drop-zone-area"
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-[calc(var(--radius)*2)] border border-dashed border-border-secondary px-6 py-8 text-center outline-none",
        "data-[drop-target]:border-accent data-[drop-target]:bg-accent-soft",
        "data-[focus-visible]:ring-2 data-[focus-visible]:ring-[var(--focus)]",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...rest}
    >
      {children}
    </AriaDropZone>
  );
}

function Icon({ className, children, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span data-slot="drop-zone-icon" className={cn("flex items-center justify-center text-muted [&_svg]:size-8", className)} {...rest}>
      {children ?? <CloudUpload />}
    </span>
  );
}

function Label({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return <Text slot="label" data-slot="drop-zone-label" className={cn("text-sm font-medium text-foreground", className)} {...rest} />;
}

function Description({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span data-slot="drop-zone-description" className={cn("text-xs text-muted", className)} {...rest} />;
}

function Trigger({ className, children, ...rest }: Omit<AriaButtonProps, "className" | "children"> & { className?: string; children?: ReactNode }) {
  const { openFilePicker } = useDropZone();
  return (
    <AriaButton
      data-slot="drop-zone-trigger"
      onPress={openFilePicker}
      className={cn(
        "mt-1 inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-[calc(var(--radius)*3)] border border-border bg-transparent px-4 text-sm font-medium text-default-foreground outline-none md:h-9",
        "transition-[transform,background-color] duration-100 motion-reduce:transition-none",
        "[@media(hover:hover)]:data-[hovered]:bg-[color-mix(in_srgb,var(--color-default)_60%,transparent)] data-[pressed]:scale-[0.97] data-[pressed]:bg-default",
        "data-[focus-visible]:ring-2 data-[focus-visible]:ring-[var(--focus)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...rest}
    >
      {children ?? "Select files"}
    </AriaButton>
  );
}

function Input({
  className,
  onSelect,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "onSelect" | "type"> & { onSelect?: (files: FileList) => void }) {
  const { inputRef } = useDropZone();
  const onChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (files && files.length > 0) onSelect?.(files);
      event.target.value = "";
    },
    [onSelect],
  );
  return (
    <input
      ref={inputRef}
      type="file"
      tabIndex={-1}
      data-slot="drop-zone-input"
      className={cn("sr-only", className)}
      onChange={onChange}
      {...rest}
    />
  );
}

export const DropZone = Object.assign(Root, { Area, Icon, Label, Description, Trigger, Input });
