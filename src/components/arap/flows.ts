/**
 * The entry a document posts, as the two ends of a flow diagram: where the money comes from (the
 * credit) and where it lands (the debit), each end in its account's category colour and glyph.
 * Pure: the documents' own figures, no reads.
 */

import type { FlowNode, FlowTarget } from "@/components/charts";
import { CATEGORIES, categoryForCode } from "@/lib/ui/categories";

import type { BillDetail, InvoiceDetail, MoneyDocDetail } from "./types";

export interface Flow {
  from: FlowNode;
  to: FlowTarget[];
}

/** "1320 Raw Ingredients" → { code: "1320", name: "Raw Ingredients" }. */
export function splitAccountLabel(label: string): { code: string; name: string } {
  const match = /^(\S+)\s+(.*)$/.exec(label.trim());
  return match ? { code: match[1], name: match[2] } : { code: "", name: label };
}

/** "Relay — Operating Expenses ••9726" → "Operating ••9726": the bank is in the glyph. */
function shortAccountName(name: string): string {
  return name.replace(/^[^—]*—\s*/, "").replace(/\s+Expenses\b/, "") || name;
}

function accountNode(label: string): FlowNode {
  const { code, name } = splitAccountLabel(label);
  const category = categoryForCode(code);
  return { label: shortAccountName(name), glyph: category.glyph, tint: category.tint };
}

const RECEIVABLES: FlowNode = { label: "Receivables", glyph: CATEGORIES.receivables.glyph, tint: CATEGORIES.receivables.tint };
const PAYABLES: FlowNode = { label: "Payables", glyph: CATEGORIES.payables.glyph, tint: CATEGORIES.payables.tint };

/** An invoice: sales (credit) into receivables (debit). */
export function invoiceFlow(invoice: InvoiceDetail): Flow {
  const revenue = CATEGORIES.revenue;
  return {
    from: { label: invoice.channelName ?? "Sales", glyph: revenue.glyph, tint: revenue.tint },
    to: [{ ...RECEIVABLES, cents: invoice.totalCents }],
  };
}

/** A bill: payables (credit) into each line's account (debit), one arrow per account. */
export function billFlow(bill: BillDetail): Flow {
  const byAccount = new Map<string, FlowTarget>();
  for (const line of bill.lines) {
    const node = accountNode(line.accountLabel);
    const existing = byAccount.get(line.accountId);
    if (existing) existing.cents += line.amountCents;
    else byAccount.set(line.accountId, { ...node, cents: line.amountCents });
  }
  return { from: PAYABLES, to: [...byAccount.values()] };
}

/** A receipt: receivables (credit) into the account the money was deposited to (debit). */
export function receiptFlow(doc: MoneyDocDetail): Flow {
  return { from: RECEIVABLES, to: [{ ...accountNode(doc.accountLabel), cents: doc.amountCents }] };
}

/** A bill payment: the bank or card (credit) into payables (debit). */
export function paymentFlow(doc: MoneyDocDetail): Flow {
  return { from: accountNode(doc.accountLabel), to: [{ ...PAYABLES, cents: doc.amountCents }] };
}
