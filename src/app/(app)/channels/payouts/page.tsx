import type { Metadata } from "next";

import { LinkTabs } from "@/components/banking/link-tabs";
import { SettlementImport } from "@/components/channels/settlement-import";
import { SettlementTable } from "@/components/channels/settlement-table";
import { PROVIDER_KEYS, PROVIDER_NAME, isProviderKey, type ProviderKey } from "@/components/channels/types";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";

import { settlementCounts, settlementRows } from "../queries";

export const metadata: Metadata = {
  title: "Payouts",
};

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Channel settlements: import a provider's export, then open a settlement to see the entry
 * it will post. Gross sales, tax and fees post in full against the channel's clearing
 * account — revenue is never booked net — and the bank deposit clears it.
 */
export default async function PayoutsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [user, params] = await Promise.all([requireUser("/channels/payouts"), searchParams]);
  const raw = Array.isArray(params.provider) ? params.provider[0] : params.provider;
  const provider: ProviderKey | null = raw !== undefined && isProviderKey(raw) ? raw : null;
  const [rows, counts] = await Promise.all([settlementRows(provider), settlementCounts()]);
  const all = Object.values(counts).reduce((a, b) => a + b, 0);
  const label = provider === null ? "any channel" : PROVIDER_NAME[provider];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="Channels"
        title="Payouts"
        description="Each settlement posts its gross sales, sales tax and fees against the channel's clearing account. The bank deposit takes that account back to zero."
        tabs={
          <LinkTabs
            label="Channel"
            tabs={[
              { href: "/channels/payouts", label: "All", count: all, active: provider === null },
              ...PROVIDER_KEYS.map((key) => ({
                href: `/channels/payouts?provider=${key}`,
                label: PROVIDER_NAME[key],
                count: counts[key],
                active: provider === key,
              })),
            ]}
          />
        }
      />

      <SettlementImport key={provider ?? "all"} initialProvider={provider ?? "square"} canImport={can(user.role, "bank.import")} />

      <Card>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>Settlements</CardTitle>
            <CardDescription>Open one to see the journal entry it will post, then post it.</CardDescription>
          </div>
        </CardHeader>
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-muted-foreground">
            No settlement from {label} has been imported yet.
            {provider === null || provider === "square"
              ? " Square is the live channel; its deposits in Relay are waiting for these settlements."
              : " Import the file above to connect it."}
          </p>
        ) : (
          <SettlementTable rows={rows} showProvider={provider === null} />
        )}
      </Card>
    </div>
  );
}
