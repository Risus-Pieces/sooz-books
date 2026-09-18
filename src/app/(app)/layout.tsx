import { cookies } from "next/headers";

import { AppShell } from "@/components/shell/app-shell";
import { NAV_COLLAPSE_COOKIE } from "@/components/shell/nav";
import { ROLE_LABELS } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";
import { queueCounts } from "@/lib/banking/queue";
import { today } from "@/lib/dates";
import { periodFor } from "@/lib/ledger/periods";

/**
 * The authenticated boundary. Everything under `(app)` renders inside it, so this is the one
 * place that has to establish who is asking — the proxy only knows whether a session exists,
 * not whether the account behind it is still active.
 *
 * It also reads the two facts the shell shows on every screen: the review queue's count (the
 * Review badge) and the working period.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const [user, store] = await Promise.all([requireUser(), cookies()]);
  const collapsed = store.get(NAV_COLLAPSE_COOKIE)?.value === "1";
  // Sequential on purpose: the connection pool this app shares is small.
  const period = await periodFor(today());
  const counts = await queueCounts();

  return (
    <AppShell
      defaultCollapsed={collapsed}
      reviewCount={counts.byStage.review}
      account={{ name: user.fullName ?? user.email, email: user.email, roleLabel: ROLE_LABELS[user.role] }}
      period={{ year: period.year, month: period.month, status: period.status }}
    >
      {children}
    </AppShell>
  );
}
