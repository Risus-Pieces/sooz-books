import type { Metadata } from "next";

import { ClearingAccount, UnconnectedChannel } from "@/components/channels/clearing-account";
import { PageToolbar } from "@/components/shell/page-toolbar";
import { ToolbarGroup, ToolbarLink } from "@/components/ui/toolbar";
import { requireUser } from "@/lib/auth/session";

import { channelCards } from "./queries";

export const metadata: Metadata = {
  title: "Channels",
};

/**
 * Where each sales channel's money stands. A settlement posts gross sales, tax and fees against
 * the channel's clearing account; the bank deposit takes it back to zero. Each live channel is a
 * picture of those two halves; the channels not yet connected are quiet tiles with one action.
 */
export default async function ChannelsPage() {
  await requireUser("/channels");
  const cards = await channelCards();
  const live = cards.filter((card) => card.connected);
  const waiting = cards.filter((card) => !card.connected);

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title="Channels"
        subtitle={`${live.length} live`}
        info={
          <>
            <p>Each channel&apos;s settlements post against its own clearing account, and the bank deposit clears it.</p>
            <p>Zero means both halves are in. Revenue is never booked net: gross sales, tax and fees each post on their own line.</p>
          </>
        }
        actions={
          <>
            <ToolbarGroup>
              <ToolbarLink href="/channels/payouts#import" glyph="import" label="Import settlements" />
            </ToolbarGroup>
            <ToolbarGroup className="max-md:hidden">
              <ToolbarLink href="/channels/payouts" glyph="list" label="Payouts" />
              <ToolbarLink href="/channels/sales-tax" glyph="percent" label="Sales tax" />
            </ToolbarGroup>
          </>
        }
      />

      {live.map((card) => (
        <ClearingAccount key={card.provider} card={card} />
      ))}

      {waiting.length === 0 ? null : (
        <section aria-labelledby="not-connected">
          <h2 id="not-connected" className="px-4 pt-3 pb-1.5 text-sm font-semibold text-label2">
            Not connected
          </h2>
          <div className="grid gap-3 md:grid-cols-3">
            {waiting.map((card) => (
              <UnconnectedChannel key={card.provider} card={card} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
