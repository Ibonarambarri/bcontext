import { redirect } from "next/navigation";

export const metadata = {
  title: "Start · Bcontext",
  robots: { index: false },
};

/**
 * `/signup` is the address people and old links type; `/start` is where
 * signing up actually happens, because an account on its own is not a thing
 * anybody can use — it comes with an organization.
 */
export default function SignupPage() {
  redirect("/start");
}
