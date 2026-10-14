/**
 * `/docs` — the index: one card per section of `DOC_SECTIONS` plus the
 * machine-readable manifests (`/llms.txt`, `/.well-known/agents.json`), which
 * the API serves and this app proxies.
 */
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { DOC_SECTIONS } from "./_components";

export const metadata = {
  title: "Docs — Bcontext",
  description:
    "How to connect Claude Code to Bcontext, call the REST API, and ship skill nodes.",
};

export default function DocsIndexPage() {
  const sections = DOC_SECTIONS.filter((s) => s.href !== "/docs");
  return (
    <article className="max-w-3xl">
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--fg-subtle)]">
        Documentation
      </p>
      <h1 className="mt-3 text-3xl font-semibold leading-[1.1] tracking-tight text-[var(--fg)] sm:text-4xl">
        Build with Bcontext.
      </h1>
      <p className="mt-5 text-[15px] leading-relaxed text-[var(--fg-muted)]">
        Bcontext is a typed knowledge graph + RAG + MCP server. Humans edit
        nodes in the web app; agents read and write the same nodes through
        an MCP transport or a thin REST surface. These docs cover what
        you&apos;ll touch in your first week: connecting an MCP client,
        calling the REST API, and authoring skill nodes.
      </p>

      <div className="mt-10 grid gap-3 sm:grid-cols-2">
        {sections.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="group rounded-lg border border-[var(--border)] bg-[var(--bg-subtle)] p-5 hover:border-[var(--border-strong)] hover:bg-[var(--bg-muted)]"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-[15px] font-semibold text-[var(--fg)]">
                {s.label}
              </h2>
              <ArrowRight
                size={14}
                className="text-[var(--fg-subtle)] transition-transform group-hover:translate-x-0.5"
              />
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--fg-muted)]">
              {s.blurb}
            </p>
          </Link>
        ))}
      </div>

      <section className="mt-12 rounded-lg border border-[var(--border)] bg-[var(--bg-subtle)] p-5">
        <h2 className="text-[15px] font-semibold text-[var(--fg)]">
          Need help?
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--fg-muted)]">
          Check{" "}
          <a
            href="/llms.txt"
            className="text-[var(--fg)] underline decoration-[var(--border-strong)] underline-offset-2 hover:decoration-[var(--fg)]"
          >
            /llms.txt
          </a>{" "}
          and{" "}
          <a
            href="/.well-known/agents.json"
            className="text-[var(--fg)] underline decoration-[var(--border-strong)] underline-offset-2 hover:decoration-[var(--fg)]"
          >
            /.well-known/agents.json
          </a>{" "}
          for machine-readable manifests.
        </p>
      </section>
    </article>
  );
}
