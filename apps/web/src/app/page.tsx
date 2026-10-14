import { redirect } from "next/navigation";

/**
 * The web app has no marketing surface. The root simply drops you into the
 * product, and /workspaces bounces unauthenticated visitors to /login.
 */
export default function Home(): never {
  redirect("/workspaces");
}
