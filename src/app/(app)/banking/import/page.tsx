import type { Metadata } from "next";

import { ImportWizard } from "@/components/banking/import-wizard";
import { PageToolbar } from "@/components/shell/page-toolbar";
import { EmptyState } from "@/components/ui/empty-state";
import { IconBadge } from "@/components/ui/icon-badge";
import { InsetGroup, ListRow } from "@/components/ui/inset-group";
import { can } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";

import { bankAccountTabs, recentImports } from "../queries";

export const metadata: Metadata = {
  title: "Import",
};

const BACK = { href: "/banking", label: "Accounts" };

/**
 * Loading a bank statement: preview first, then commit. The preview writes nothing but the
 * record of the attempt, and a committed import only ever fills the review queue.
 */
export default async function ImportPage() {
  const user = await requireUser("/banking/import");
  if (!can(user.role, "bank.import")) {
    return (
      <div className="flex flex-col gap-3.5 max-md:gap-3">
        <PageToolbar title="Import" back={BACK} />
        <EmptyState
          glyph="lock"
          title="Not part of your role"
          description="Importing is not part of your role. Ask the owner or the bookkeeper to load the statement."
        />
      </div>
    );
  }
  const [accounts, recent] = await Promise.all([bankAccountTabs(), recentImports()]);

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title="Import"
        back={BACK}
        info="Load a statement from the bank. You see exactly what it would add before anything is written."
      />

      <ImportWizard accounts={accounts} />

      <InsetGroup header="Recent" separatorInset={52}>
        {recent.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm font-medium text-label2">No imports yet</p>
        ) : (
          recent.map((batch) => (
            <ListRow
              key={batch.id}
              leading={<IconBadge glyph="doc-text" tint="green" size="lg" />}
              title={batch.filename}
              subtitle={batch.bankLabel}
              trailing={<span className="num">+{batch.importedCount}</span>}
              detail={
                <span className="num">
                  {batch.duplicateCount > 0 ? <span className="max-sm:hidden">{batch.duplicateCount} dup · </span> : null}
                  {batch.createdAt}
                </span>
              }
            />
          ))
        )}
      </InsetGroup>
    </div>
  );
}
