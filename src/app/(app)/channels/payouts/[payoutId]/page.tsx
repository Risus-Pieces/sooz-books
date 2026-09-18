import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { SettlementDetail } from "@/components/channels/settlement-detail";
import { PROVIDER_NAME } from "@/components/channels/types";
import { PageToolbar } from "@/components/shell/page-toolbar";
import { can } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";

import { settlementDetail } from "../../queries";

export async function generateMetadata({ params }: { params: Promise<{ payoutId: string }> }): Promise<Metadata> {
  const { payoutId } = await params;
  const detail = await settlementDetail(payoutId);
  return { title: detail === null ? "Settlement" : `${PROVIDER_NAME[detail.row.provider]} settlement` };
}

/**
 * One settlement. Before it posts, the page shows exactly the entry posting will write — built by
 * the same function the posting engine uses — as a flow, with every line one click away.
 */
export default async function SettlementPage({ params }: { params: Promise<{ payoutId: string }> }) {
  const [user, { payoutId }] = await Promise.all([requireUser(), params]);
  const detail = await settlementDetail(payoutId);
  if (detail === null) notFound();
  const { row } = detail;

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title="Settlement"
        phoneTitleRow
        back={{ href: `/channels/payouts?provider=${row.provider}`, label: "Payouts" }}
        info={
          <>
            <p>
              Posting writes gross sales, sales tax and fees against the {PROVIDER_NAME[row.provider]} clearing account, never the net. The
              bank deposit takes the account back to zero.
            </p>
            <p>A posted entry cannot be edited; unposting reverses it.</p>
          </>
        }
      />
      <SettlementDetail detail={detail} canPost={can(user.role, "ledger.post")} canLink={can(user.role, "bank.approve")} variant="page" />
    </div>
  );
}
