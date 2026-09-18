import { redirect } from "next/navigation";

/** There is no marketing surface here; the books open on the dashboard. */
export default function RootPage(): never {
  redirect("/dashboard");
}
