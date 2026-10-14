import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";

/**
 * Chrome-less shell for auth pages, in the paper language: white in both
 * themes, the mark and the wordmark back to this instance's root, the way in
 * at the top right, and the content centred.
 * Type comes from the root layout (src/lib/fonts.ts) — see .auth-paper in
 * globals.css.
 */

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="auth-paper">
      <header className="pa-top">
        <Link className="pa-brand" href="/">
          <Image
            className="pa-brand-mark"
            src="/icon-512.png"
            alt=""
            width={28}
            height={28}
            priority
          />
          Bcontext
        </Link>
        <a className="pa-start" href="/start">
          Start now
        </a>
      </header>

      <main className="pa-main">
        <div className="pa-content">{children}</div>
      </main>

      <footer className="pa-bottom">
        <span>Bcontext · {new Date().getFullYear()}</span>
      </footer>
    </div>
  );
}
