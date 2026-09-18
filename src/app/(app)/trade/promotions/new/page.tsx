import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { PromotionForm } from "@/components/trade/promotion-form";
import { can } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";
import { today } from "@/lib/dates";

import { promotionFormOptions } from "../../queries";

export const metadata: Metadata = {
  title: "New promotion",
};

/** Planning a promotion. Saving posts nothing; the accrual posts from the promotion's page. */
export default async function NewPromotionPage() {
  const user = await requireUser("/trade/promotions/new");
  if (!can(user.role, "trade.manage")) redirect("/trade/promotions");
  const options = await promotionFormOptions();
  return <PromotionForm options={options} today={today()} />;
}
