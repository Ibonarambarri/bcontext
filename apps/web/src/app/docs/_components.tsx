import type { Route } from "next";
import type { ReactNode } from "react";

/**
 * Shared building blocks for `/docs/*` pages. Kept colocated under
 * `src/app/docs/_components.tsx` (leading underscore opts out of routing
 * in Next.js App Router) so the docs section stays self-contained.
 */

export interface DocSection {
  href: Route;
  label: string;
  blurb: string;
}

export const DOC_SECTIONS: DocSection[] = [
  {
    href: "/docs",
    label: "Overview",
    blurb: "What Bcontext is and how the pieces fit.",
  },
  {
    href: "/docs/quickstart",
    label: "Quickstart",
    blurb: "Connect Claude Code or Claude Desktop via MCP.",
  },
  {
    href: "/docs/api",
    label: "API reference",
    blurb: "REST endpoints, auth, rate limits, examples.",
  },
  {
    href: "/docs/skills",
    label: "Skill recipes",
    blurb: "Skill nodes, skills_run, and the AGENTS.md generator.",
  },
  {
    href: "/docs/connectors" as Route,
    label: "Connectors",
    blurb: "GitHub, Slack, Linear, Notion — install, scopes, webhooks.",
  },
];

export function DocHeader({
  eyebrow,
  title,
  lede,
}: {
  eyebrow: string;
  title: string;
  lede: string;
}) {
  return (
    <header>
      <p className="font-mono text-app-xs uppercase tracking-[0.2em] text-[var(--fg-subtle)]">
        {eyebrow}
      </p>
      <h1 className="mt-4 text-app-3xl font-semibold leading-[1.1] tracking-tight text-[var(--fg)] sm:text-app-4xl">
        {title}
      </h1>
      <p className="mt-6 max-w-2xl text-app-lg leading-relaxed text-[var(--fg-muted)]">
        {lede}
      </p>
    </header>
  );
}

export function DocSection({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-14">
      {title ? (
        <h2 className="text-app-xl font-semibold tracking-tight text-[var(--fg)]">
          {title}
        </h2>
      ) : null}
      <div className="mt-5 space-y-5 text-app-base leading-relaxed text-[var(--fg-muted)]">
        {children}
      </div>
    </section>
  );
}

export function Code({
  label,
  code,
  caption,
}: {
  label?: string;
  code: string;
  caption?: string;
}) {
  return (
    <figure className="my-3 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-subtle)]">
      {label ? (
        <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-2.5">
          <span className="font-mono text-app-xs uppercase tracking-widest text-[var(--fg-muted)]">
            {label}
          </span>
        </div>
      ) : null}
      <pre className="overflow-x-auto px-5 py-5 text-[13px] leading-relaxed">
        <code className="hljs font-mono text-[var(--fg)]">{code}</code>
      </pre>
      {caption ? (
        <figcaption className="border-t border-[var(--border)] px-5 py-2.5 text-app-sm text-[var(--fg-subtle)]">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}

export function Inline({ children }: { children: ReactNode }) {
  return (
    <code className="rounded border border-[var(--border)] bg-[var(--bg-muted)] px-1.5 py-0.5 font-mono text-[0.92em] text-[var(--fg)]">
      {children}
    </code>
  );
}
