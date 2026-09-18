import type { Metadata } from "next";
import Link from "next/link";
import { Receipt, Upload } from "lucide-react";

import { ClearingAccount, UnconnectedChannel } from "@/components/channels/clearing-account";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { requireUser } from "@/lib/auth/session";

import { channelCards } from "./queries";

export const metadata: Metadata = {
  title: "Channels",
};

/**
 * Where each sales channel's money stands. A settlement posts gross sales, tax and fees
 * against the channel's clearing account; the bank deposit takes it back to zero. Each card
 * says which half of that is missing, if either.
 */
export default async function ChannelsPage() {
  await requireUser("/channels");
  const cards = await channelCards();
  const live = cards.filter((card) => card.connected);
  const waiting = cards.filter((card) => !card.connected);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Channels"
        title="Sales channels"
        description="Each channel's settlements post against its clearing account and the bank deposit clears it. Zero means both halves are in."
        actions={
          <>
            <Button asChild size="sm" variant="secondary">
              <Link href="/channels/sales-tax">
                <Receipt />
                Sales tax
              </Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/channels/payouts#import">
                <Upload />
                Import settlements
              </Link>
            </Button>
          </>
        }
      />

      {live.map((card) => (
        <ClearingAccount key={card.provider} card={card} />
      ))}

      {waiting.length === 0 ? null : (
        <section aria-labelledby="unconnected" className="flex flex-col gap-2">
          <h2 id="unconnected" className="eyebrow">
            Planned channels · no data yet
          </h2>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {waiting.map((card) => (
              <UnconnectedChannel key={card.provider} card={card} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
