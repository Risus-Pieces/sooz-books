import { cookies } from "next/headers";
import { LogOut } from "lucide-react";

import { AppShell } from "@/components/shell/app-shell";
import { NAV_COLLAPSE_COOKIE } from "@/components/shell/nav";
import { PeriodIndicator } from "@/components/shell/period-indicator";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { signOut } from "@/lib/auth/actions";
import { ROLE_LABELS } from "@/lib/auth/roles";
import { requireUser, type AuthedUser } from "@/lib/auth/session";
import { today } from "@/lib/dates";
import { periodFor } from "@/lib/ledger/periods";

/**
 * The authenticated boundary. Everything under `(app)` renders inside it, so this is the one
 * place that has to establish who is asking — the proxy only knows whether a session exists,
 * not whether the account behind it is still active.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const [user, store] = await Promise.all([requireUser(), cookies()]);
  const collapsed = store.get(NAV_COLLAPSE_COOKIE)?.value === "1";
  const period = await periodFor(today());

  return (
    <AppShell
      defaultCollapsed={collapsed}
      user={<AccountChip user={user} />}
      period={
        <PeriodIndicator
          year={period.year}
          month={period.month}
          status={period.status}
          href="/close"
        />
      }
    >
      {children}
    </AppShell>
  );
}

/**
 * Server-rendered on purpose: identity is not something to hydrate for. The sign-out button is
 * a plain form posting to a server action, so it works before — and without — JavaScript.
 */
function AccountChip({ user }: { user: AuthedUser }) {
  return (
    <div className="flex items-center gap-2">
      <div className="hidden min-w-0 flex-col items-end leading-tight sm:flex">
        <span className="max-w-44 truncate text-xs font-medium text-foreground">
          {user.fullName ?? user.email}
        </span>
        <span className="max-w-44 truncate text-2xs text-muted-foreground">{user.email}</span>
      </div>
      <Badge tone={user.role === "owner" ? "primary" : "neutral"}>{ROLE_LABELS[user.role]}</Badge>
      <form action={signOut}>
        <Button
          type="submit"
          variant="ghost"
          size="icon-sm"
          title="Sign out"
          aria-label="Sign out"
        >
          <LogOut />
        </Button>
      </form>
    </div>
  );
}
