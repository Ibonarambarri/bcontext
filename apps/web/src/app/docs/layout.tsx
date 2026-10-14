/**
 * Shell of the product docs at `/docs/*`: sticky header,
 * the section sidebar built from `DOC_SECTIONS`, and the page. Public and
 * static — nothing here reads the API or needs a session.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { DOC_SECTIONS } from "./_components";
import { DocsHeader } from "./docs-header";

export const metadata = {
  title: "Docs — Bcontext",
  description:
    "Connect Claude Code via MCP, call the REST API, and ship skill nodes inside Bcontext.",
};

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--fg)]">
      <DocsHeader />
      <div className="mx-auto flex max-w-6xl gap-10 px-4 py-12 sm:px-6 sm:py-16">
        <DocsSidebar />
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}

function DocsSidebar() {
  return (
    <aside className="hidden w-60 shrink-0 lg:block">
      <nav className="sticky top-20 flex flex-col gap-1 text-app-sm">
        <p className="mb-3 font-mono text-app-xs uppercase tracking-[0.2em] text-[var(--fg-subtle)]">
          Documentation
        </p>
        {DOC_SECTIONS.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="rounded-md px-3 py-2 text-[var(--fg-muted)] hover:bg-[var(--bg-muted)] hover:text-[var(--fg)]"
          >
            {s.label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}
