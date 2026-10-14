/**
 * The furniture every admin DETAIL screen is made of — the titled section,
 * the figure, and the answer that has nothing in it.
 *
 * It exists for the same reason `list-ui` does, and it was written the day
 * the second detail page copied the first one's three helpers verbatim. Two
 * copies is where the drift starts: a section's hint moves to a different
 * size on one page, a Stat gets a tighter box on the other, and the panel
 * stops looking like one instrument.
 *
 * Server components only need these to render, so nothing here is a client
 * component — the customer page and the problem page both call them from the
 * server.
 */

import type { ReactNode } from "react";
import {
  EmptyState,
  EmptyStateDescription,
  EmptyStateHeader,
} from "@/components/ui/empty-state";

/** The mono stack the panel's figures and identifiers are set in. */
const monoStyle: React.CSSProperties = {
  fontFamily: "var(--f-martian-mono), var(--font-mono), monospace",
};

/**
 * A titled part of a detail page, with the one sentence that says what it is
 * for.
 *
 * The hint is not decoration: these screens are read at speed by one person
 * who wants to know whether a section is worth reading at all, and a heading
 * alone rarely answers that. It is optional because some sections are their
 * own explanation.
 */
export function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-8">
      <h2 className="text-[14px] font-medium text-[var(--ink)]">{title}</h2>
      {hint && (
        <p className="mb-3 mt-0.5 max-w-2xl text-[11.5px] text-[var(--ink-3)]">
          {hint}
        </p>
      )}
      <div className={hint ? "" : "mt-3"}>{children}</div>
    </section>
  );
}

/** A section with nothing in it, drawn the way every other empty answer in
 *  the panel is drawn. */
export function Empty({ children }: { children: ReactNode }) {
  return (
    <EmptyState size="sm">
      <EmptyStateHeader>
        <EmptyStateDescription>{children}</EmptyStateDescription>
      </EmptyStateHeader>
    </EmptyState>
  );
}

/**
 * One figure, named, with the qualifier that stops it being read wrong.
 *
 * `value` is a string and not a number on purpose: half of these are counts
 * and half are answers like "yesterday" or an em dash for none, and a
 * component that formatted numbers itself would force the second kind to lie
 * about its type. The caller formats — with a fixed locale, so the server and
 * the browser agree.
 */
export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-md border border-[var(--line)] px-3 py-2.5">
      <div className="mono text-[10.5px] uppercase tracking-[0.06em] text-[var(--ink-mute)]">
        {label}
      </div>
      <div
        className="mt-1 text-[22px] leading-none text-[var(--ink)]"
        style={monoStyle}
      >
        {value}
      </div>
      <div className="mt-1 text-[10.5px] text-[var(--ink-3)]">{hint}</div>
    </div>
  );
}
