import type { Metadata } from "next";

import { RulesManager } from "@/components/banking/rules-manager";
import { can } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";

import { accountOptions } from "../../ledger/queries";
import { bankAccountTabs, ruleRows, vendorOptions } from "../queries";

export const metadata: Metadata = {
  title: "Rules",
};

/**
 * The owner's categorization rules, in the order the importer tries them. A rule proposes an
 * account for the next import; only one the owner marks auto-post lets a match post unreviewed.
 */
export default async function RulesPage() {
  const user = await requireUser("/banking/rules");
  const [rules, accounts, vendors, banks] = await Promise.all([
    ruleRows(),
    accountOptions(),
    vendorOptions(),
    bankAccountTabs(),
  ]);

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <RulesManager
        rules={rules}
        accounts={accounts}
        vendors={vendors}
        banks={banks}
        canEdit={can(user.role, "bank.import")}
        // Letting a rule post without review is the owner's decision; settings.manage is the
        // owner-only capability for decisions that change what the books mean.
        mayAutoPost={can(user.role, "settings.manage")}
      />
    </div>
  );
}
