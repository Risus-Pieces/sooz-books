import type { Metadata } from "next";

import { DEPOSIT_LABEL, DEPOSIT_TINT, PROVIDER_BADGE, monthName, shortDate } from "@/components/channels/parts";
import { SettlementDetail } from "@/components/channels/settlement-detail";
import { SettlementImportButton, SettlementImportProvider } from "@/components/channels/settlement-import";
import { PROVIDER_KEYS, PROVIDER_NAME, isProviderKey, type ProviderKey, type SettlementRowView } from "@/components/channels/types";
import { PageToolbar } from "@/components/shell/page-toolbar";
import { SplitView } from "@/components/ui/detail-pane";
import { EmptyState } from "@/components/ui/empty-state";
import { Dot, IconBadge } from "@/components/ui/icon-badge";
import { InsetGroup, ListRow } from "@/components/ui/inset-group";
import { Money } from "@/components/ui/money";
import { SegmentedNav } from "@/components/ui/segmented-control";
import { ToolbarGroup } from "@/components/ui/toolbar";
import { can } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";

import { settlementCounts, settlementDetail, settlementRows } from "../queries";

export const metadata: Metadata = {
  title: "Payouts",
};

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Settlements grouped under their month, newest first. */
function byMonth(rows: readonly SettlementRowView[]): { key: string; label: string; rows: SettlementRowView[] }[] {
  const groups = new Map<string, SettlementRowView[]>();
  for (const row of rows) {
    const date = row.periodEnd ?? row.periodStart;
    const key = date === null ? "none" : `${date.slice(0, 7)}-01`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([key, list]) => ({ key, label: key === "none" ? "Undated" : monthName(key), rows: list }));
}

/**
 * Channel settlements: a list by month, and beside it the selected settlement with the entry it
 * will post, drawn as a flow. Gross sales, tax and fees post in full against the channel's clearing
 * account — revenue is never booked net — and the bank deposit clears it.
 */
export default async function PayoutsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [user, params] = await Promise.all([requireUser("/channels/payouts"), searchParams]);
  const raw = first(params.provider);
  const provider: ProviderKey | null = raw !== undefined && isProviderKey(raw) ? raw : null;
  const rows = await settlementRows(provider);
  const counts = await settlementCounts();
  const all = Object.values(counts).reduce((a, b) => a + b, 0);
  const selectedId = first(params.id);
  const selected = rows.find((r) => r.id === selectedId) ?? rows[0] ?? null;
  const detail = selected === null ? null : await settlementDetail(selected.id);
  const net = rows.reduce((sum, r) => sum + r.netCents, 0);
  const canImport = can(user.role, "bank.import");
  const query = (extra: Record<string, string>) => {
    const search = new URLSearchParams({ ...(provider === null ? {} : { provider }), ...extra });
    const text = search.toString();
    return text === "" ? "/channels/payouts" : `/channels/payouts?${text}`;
  };
  const groups = byMonth(rows);

  const row = (r: SettlementRowView, desktop: boolean) => {
    const badge = PROVIDER_BADGE[r.provider];
    return (
      <ListRow
        key={r.id}
        href={desktop ? query({ id: r.id }) : `/channels/payouts/${r.id}`}
        selected={desktop && selected?.id === r.id}
        chevron={!desktop}
        leading={<IconBadge glyph={badge.glyph} tint={badge.tint} size="xl" className="rounded-full" />}
        title={PROVIDER_NAME[r.provider]}
        subtitle={
          <>
            <Dot tint={DEPOSIT_TINT[r.depositState]} size={7} />
            {DEPOSIT_LABEL[r.depositState]}
            <span className="opacity-70">·</span>
            {r.entryNo === null ? "Not posted" : `#${r.entryNo}`}
          </>
        }
        trailing={<Money cents={r.netCents} currency plain />}
        detail={shortDate(r.periodEnd ?? r.periodStart)}
      />
    );
  };

  return (
    <SettlementImportProvider key={provider ?? "all"} initialProvider={provider ?? "square"} canImport={canImport}>
      <div className="flex flex-col gap-3.5 max-md:gap-3">
        <PageToolbar
          title="Payouts"
          subtitle={
            rows.length === 0 ? undefined : (
              <>
                {rows.length} · <Money cents={net} currency plain /> net
              </>
            )
          }
          info={
            <>
              <p>Each settlement posts its gross sales, sales tax and fees against the channel&apos;s clearing account.</p>
              <p>The bank deposit takes that account back to zero. Open a settlement to see the entry it will post, then post it.</p>
            </>
          }
          actions={
            <ToolbarGroup>
              <SettlementImportButton />
            </ToolbarGroup>
          }
        />

        <SegmentedNav
          aria-label="Channel"
          current={provider ?? "all"}
          className="self-start max-sm:w-full"
          fill={false}
          items={[
            { value: "all", label: all > 0 ? `All ${all}` : "All", href: "/channels/payouts" },
            ...PROVIDER_KEYS.map((key) => ({
              value: key,
              label: counts[key] > 0 ? `${PROVIDER_NAME[key]} ${counts[key]}` : PROVIDER_NAME[key],
              href: `/channels/payouts?provider=${key}`,
            })),
          ]}
        />

        {rows.length === 0 ? (
          <div className="rounded-2xl bg-card shadow-card max-md:rounded-[22px]">
            <EmptyState
              glyph="tray"
              title={provider === null ? "No settlements yet" : `No ${PROVIDER_NAME[provider]} settlements`}
              description={
                provider === null || provider === "square"
                  ? "Square is the live channel; its deposits in Relay are waiting for these settlements."
                  : "Import the channel's settlement file to connect it."
              }
              action={canImport ? <SettlementImportButton appearance="button" label="Import" /> : undefined}
            />
          </div>
        ) : (
          <>
            {/* Desktop: list beside the selected settlement. */}
            <div className="max-lg:hidden">
              <SplitView
                listWidth={360}
                className="overflow-clip rounded-2xl bg-bg shadow-card"
                list={
                  <div className="px-1.5 pb-2">
                    {groups.map((g) => (
                      <InsetGroup key={g.key} variant="plain" header={g.label} separatorInset={57}>
                        {g.rows.map((r) => row(r, true))}
                      </InsetGroup>
                    ))}
                  </div>
                }
                detail={
                  detail === null ? null : (
                    <SettlementDetail detail={detail} canPost={can(user.role, "ledger.post")} canLink={can(user.role, "bank.approve")} variant="pane" />
                  )
                }
              />
            </div>
            {/* Phone and tablet: a list that pushes the settlement's page. */}
            <div className="lg:hidden">
              {groups.map((g) => (
                <InsetGroup key={g.key} header={g.label} separatorInset={63}>
                  {g.rows.map((r) => row(r, false))}
                </InsetGroup>
              ))}
            </div>
          </>
        )}
      </div>
    </SettlementImportProvider>
  );
}
