"use client";

/**
 * Stepper — numbered progress through a fixed list of steps. Horizontal in
 * the multi-step modals (Add agent, meeting-records setup), vertical as the
 * bot-status timeline of a meeting recording.
 *
 * Status per step is derived from `currentStep` (before = complete, equal =
 * active, after = inactive) and exposed as `data-status` on the step and its
 * indicator, so titles and colours follow without props. Colours come from
 * CSS variables (`--stepper-active-color`, `--stepper-complete-color`) that a
 * call site may override inline — the recording timeline turns them red when
 * the bot failed, so those two names must keep working.
 *
 * The separator is a sibling of the step's content, not inside it: it is
 * absolutely positioned between this indicator and the next one, and the
 * last step drops it on its own.
 */
import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  type CSSProperties,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";
import { cn } from "@bcontext-dev/contract/utils";

type Orientation = "horizontal" | "vertical";
type Size = "sm" | "md" | "lg";
type Status = "inactive" | "active" | "complete";

const RootContext = createContext<{ currentStep: number; orientation: Orientation; size: Size }>({
  currentStep: 0,
  orientation: "horizontal",
  size: "md",
});
const StepContext = createContext<{ index: number; isLast: boolean; status: Status }>({
  index: 0,
  isLast: false,
  status: "inactive",
});

const INDICATOR_SIZE: Record<Size, string> = { sm: "22px", md: "28px", lg: "36px" };
const VERTICAL_GAP: Record<Size, string> = { sm: "12px", md: "16px", lg: "24px" };

interface StepperProps extends HTMLAttributes<HTMLOListElement> {
  currentStep?: number;
  orientation?: Orientation;
  size?: Size;
  children?: ReactNode;
}

function Root({ currentStep = 0, orientation = "horizontal", size = "md", className, style, children, ...rest }: StepperProps) {
  const steps = Children.toArray(children).filter(
    (child): child is ReactElement<StepProps> => isValidElement(child) && child.type === Step,
  );
  let index = 0;
  const numbered = Children.map(children, (child) => {
    if (!isValidElement(child) || child.type !== Step) return child;
    const i = index++;
    return cloneElement(child as ReactElement<StepProps>, { _index: i, _isLast: i === steps.length - 1 });
  });
  return (
    <RootContext.Provider value={{ currentStep, orientation, size }}>
      <ol
        aria-label="Progress"
        data-slot="stepper"
        className={cn("m-0 flex list-none p-0", orientation === "horizontal" ? "items-start" : "flex-col", className)}
        style={{
          "--stepper-indicator-size": INDICATOR_SIZE[size],
          "--stepper-vertical-gap": VERTICAL_GAP[size],
          "--stepper-separator-size": "2px",
          "--stepper-active-color": "var(--color-accent)",
          "--stepper-complete-color": "var(--color-accent)",
          "--stepper-complete-fg": "var(--color-accent-foreground)",
          ...style,
        } as CSSProperties}
        {...rest}
      >
        {numbered}
      </ol>
    </RootContext.Provider>
  );
}

interface StepProps extends HTMLAttributes<HTMLLIElement> {
  /** Injected by the root; call sites never pass them. */
  _index?: number;
  _isLast?: boolean;
}

function Step({ _index = 0, _isLast = false, className, children, ...rest }: StepProps) {
  const { currentStep, orientation } = useContext(RootContext);
  const reached = Math.floor(currentStep);
  const status: Status = reached === _index ? "active" : reached > _index ? "complete" : "inactive";
  const body: ReactNode[] = [];
  let separator: ReactNode = null;
  Children.forEach(children, (child) => {
    if (isValidElement(child) && child.type === Separator) separator = child;
    else body.push(child);
  });
  return (
    <StepContext.Provider value={{ index: _index, isLast: _isLast, status }}>
      <li
        data-slot="stepper-step"
        data-index={_index}
        data-status={status}
        className={cn(
          "group/step relative flex flex-col",
          orientation === "horizontal"
            ? "flex-1 items-center overflow-visible"
            : "pb-[var(--stepper-vertical-gap)] last:pb-0",
          className,
        )}
        {...rest}
      >
        <div
          aria-current={status === "active" ? "step" : undefined}
          className={cn(
            "relative z-10 flex",
            orientation === "horizontal" ? "flex-col items-center gap-1.5" : "flex-row items-start gap-2.5",
          )}
        >
          {body}
        </div>
        {separator}
      </li>
    </StepContext.Provider>
  );
}

function Indicator({ className, children, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  const { size } = useContext(RootContext);
  const { index, status } = useContext(StepContext);
  return (
    <span
      data-slot="stepper-indicator"
      data-status={status}
      className={cn(
        "flex size-[var(--stepper-indicator-size)] shrink-0 items-center justify-center rounded-full border-2 font-medium tabular-nums",
        size === "sm" ? "text-[11px]" : size === "lg" ? "text-sm" : "text-xs",
        status === "inactive" && "border-border bg-transparent text-muted",
        status === "active" && "border-[var(--stepper-active-color)] bg-transparent text-[var(--stepper-active-color)]",
        status === "complete" &&
          "border-[var(--stepper-complete-color)] bg-[var(--stepper-complete-color)] text-[var(--stepper-complete-fg)]",
        className,
      )}
      {...rest}
    >
      {children ??
        (status === "complete" ? (
          <svg
            aria-hidden="true"
            viewBox="0 0 17 18"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="size-[44%]"
          >
            <polyline points="1 9 7 14 15 4" />
          </svg>
        ) : (
          <span>{index + 1}</span>
        ))}
    </span>
  );
}

function Content({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  const { orientation } = useContext(RootContext);
  return (
    <span
      data-slot="stepper-content"
      className={cn(
        "flex flex-col",
        orientation === "horizontal"
          ? "items-center text-center"
          : "min-h-[var(--stepper-indicator-size)] items-start justify-center text-left",
        className,
      )}
      {...rest}
    />
  );
}

function Title({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  const { size } = useContext(RootContext);
  return (
    <span
      data-slot="stepper-title"
      className={cn(
        "font-medium text-foreground group-data-[status=inactive]/step:text-muted",
        size === "sm" ? "text-[11px]" : "text-sm",
        className,
      )}
      {...rest}
    />
  );
}

/** Track between this step and the next; filled once the next step is reached. */
function Separator({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const { currentStep, orientation } = useContext(RootContext);
  const { index, isLast } = useContext(StepContext);
  if (isLast) return null;
  const reached = Math.floor(currentStep);
  const progress = Math.min(1, Math.max(0, reached > index ? 1 : reached === index ? currentStep - reached : 0));
  const horizontal = orientation === "horizontal";
  return (
    <div
      aria-hidden="true"
      data-slot="stepper-separator"
      className={cn(
        "absolute flex",
        horizontal
          ? "left-[calc(50%+var(--stepper-indicator-size)/2)] right-[calc(-50%+var(--stepper-indicator-size)/2)] top-[calc(var(--stepper-indicator-size)/2-var(--stepper-separator-size)/2)]"
          : "bottom-0 left-[calc(var(--stepper-indicator-size)/2-var(--stepper-separator-size)/2)] top-[var(--stepper-indicator-size)]",
        className,
      )}
      {...rest}
    >
      <div
        className={cn(
          "relative overflow-hidden bg-separator",
          horizontal ? "h-[var(--stepper-separator-size)] w-full" : "h-full w-[var(--stepper-separator-size)]",
        )}
      >
        <div
          className={cn(
            "absolute inset-0 bg-[var(--stepper-complete-color)] transition-transform duration-300 motion-reduce:transition-none",
            horizontal ? "origin-left" : "origin-top",
          )}
          style={{ transform: horizontal ? `scaleX(${progress})` : `scaleY(${progress})` }}
        />
      </div>
    </div>
  );
}

export const Stepper = Object.assign(Root, { Step, Indicator, Content, Title, Separator });
