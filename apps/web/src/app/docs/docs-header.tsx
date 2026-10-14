import Link from "next/link";
import { Navbar, navbarItemClass } from "@/components/ui/navbar";

/**
 * The `/docs/*` header: brand back to the docs index, then the two ways
 * into the product. Stateless, so it stays a server component like the
 * layout that mounts it.
 */
export function DocsHeader() {
  return (
    <Navbar position="sticky" maxWidth="xl">
      <Link href="/docs" data-slot="navbar-brand" className="flex shrink-0 items-center gap-2">
        <span className="font-mono text-sm tracking-[0.2em]">bcontext</span>
        <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--fg-subtle)]">
          docs
        </span>
      </Link>

      <Navbar.Spacer />

      <Navbar.Content>
        <Link href="/login" className={navbarItemClass}>
          Sign in
        </Link>
        {/* The way in is `/start` (account + organization), the
            same one the auth pages offer — never a landing anchor. */}
        <Link href="/start" className={navbarItemClass}>
          Start now
        </Link>
      </Navbar.Content>
    </Navbar>
  );
}
