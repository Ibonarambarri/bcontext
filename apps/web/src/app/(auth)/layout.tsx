/** The `(auth)` route group: login and forgot share the same shell (`/signup` only redirects to `/start`). */
import type { ReactNode } from "react";
import { AuthShell } from "@/components/auth/AuthShell";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return <AuthShell>{children}</AuthShell>;
}
