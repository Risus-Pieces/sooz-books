import type { Metadata } from "next";

import { ImportWizard } from "@/components/banking/import-wizard";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { can } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";

import { bankAccountTabs, recentImports } from "../queries";

export const metadata: Metadata = {
  title: "Import statement",
};

/**
 * Loading a bank statement: preview first, then commit. The preview writes nothing but the
 * record of the attempt, and a committed import only ever fills the review queue.
 */
export default async function ImportPage() {
  const user = await requireUser("/banking/import");
  if (!can(user.role, "bank.import")) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader eyebrow="Banking" title="Import statement" />
        <EmptyState title="Importing is not part of your role" description="Ask the owner or the bookkeeper to load the statement." />
      </div>
    );
  }
  const [accounts, recent] = await Promise.all([bankAccountTabs(), recentImports()]);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="Banking"
        title="Import statement"
        description="Load a statement from the bank. See exactly what it would add before anything is written."
      />

      <ImportWizard accounts={accounts} />

      <Card>
        <CardHeader>
          <CardTitle>Recent imports</CardTitle>
        </CardHeader>
        {recent.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">No statement has been imported yet.</p>
        ) : (
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[48rem] border-separate border-spacing-0 text-sm">
              <thead>
                <tr>
                  {["File", "Account", "Imported", "Already had", "When"].map((head, index) => (
                    <th
                      key={head}
                      scope="col"
                      className={`rule-head bg-surface-sunken px-3 py-1.5 text-2xs font-semibold tracking-wider text-muted-foreground uppercase ${index >= 2 && index <= 3 ? "text-right" : "text-left"}`}
                    >
                      {head}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recent.map((batch) => (
                  <tr key={batch.id}>
                    <td className="rule-row px-3 py-1.5 whitespace-nowrap">{batch.filename}</td>
                    <td className="rule-row num px-3 py-1.5 text-xs whitespace-nowrap text-muted-foreground">{batch.bankLabel}</td>
                    <td className="rule-row num px-3 py-1.5 text-right">{batch.importedCount}</td>
                    <td className="rule-row num px-3 py-1.5 text-right text-muted-foreground">{batch.duplicateCount}</td>
                    <td className="rule-row px-3 py-1.5 text-xs whitespace-nowrap text-muted-foreground">{batch.createdAt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
