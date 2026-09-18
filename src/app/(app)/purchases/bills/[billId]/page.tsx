import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Banknote, Pencil } from 'lucide-react';

import { PostDocButton } from '@/components/arap/doc-buttons';
import { DocStatusBadge, Fact, Td, Th } from '@/components/arap/doc-status';
import { termsLabel } from '@/components/arap/math';
import { VoidButton } from '@/components/arap/void-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Money, formatCents } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';
import { daysBetween, today } from '@/lib/dates';

import { approveBillAction, voidBillAction } from '../../actions';
import { billDetail } from '../../queries';

export async function generateMetadata({ params }: { params: Promise<{ billId: string }> }): Promise<Metadata> {
  const { billId } = await params;
  const bill = await billDetail(billId);
  return { title: bill === null ? 'Bill' : `${bill.vendorName} ${bill.billNo}` };
}

export default async function BillPage({ params }: { params: Promise<{ billId: string }> }) {
  const [user, { billId }] = await Promise.all([requireUser(), params]);
  const bill = await billDetail(billId);
  if (bill === null) notFound();

  const canManage = can(user.role, 'ap.manage');
  const canPay = can(user.role, 'ap.pay');
  const now = today();
  const open = bill.status === 'open' || bill.status === 'partial';
  const daysOverdue = open && bill.dueDate < now ? daysBetween(bill.dueDate, now) : 0;
  const settled = bill.paidCents + bill.creditedCents;
  const showQty = bill.lines.some((l) => l.quantity !== null);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Purchases · Bill"
        title={`${bill.vendorName} · ${bill.billNo}`}
        description={`Dated ${bill.billDate} · due ${bill.dueDate} · ${termsLabel(bill.termsDays)}`}
        meta={<DocStatusBadge status={bill.status} daysOverdue={daysOverdue} />}
        actions={
          <>
            <Button asChild variant="ghost" size="sm">
              <Link href="/purchases/bills">All bills</Link>
            </Button>
            {canManage && bill.status === 'draft' ? (
              <>
                <Button asChild variant="secondary" size="sm">
                  <Link href={`/purchases/bills/${bill.id}/edit`}>
                    <Pencil />
                    Edit draft
                  </Link>
                </Button>
                <VoidButton
                  label="Discard draft"
                  docNo={bill.billNo}
                  consequence="The draft becomes void. Nothing was posted, so nothing is reversed."
                  minDate={bill.billDate}
                  defaultDate={now}
                  needsDate={false}
                  onVoid={voidBillAction.bind(null, bill.id)}
                />
                <PostDocButton
                  label="Approve bill"
                  done="approved"
                  icon="approve"
                  confirmText={`Approve ${bill.vendorName} bill ${bill.billNo}? It posts to Accounts Payable and can only be corrected by voiding it.`}
                  onPost={approveBillAction.bind(null, bill.id)}
                />
              </>
            ) : null}
            {canPay && open ? (
              <Button asChild size="sm">
                <Link href={`/purchases/payments/new?vendor=${bill.vendorId}&bill=${bill.id}`}>
                  <Banknote />
                  Pay bill
                </Link>
              </Button>
            ) : null}
            {canManage && open && settled === 0 ? (
              <VoidButton
                label="Void bill"
                docNo={bill.billNo}
                consequence="Posts a reversal of the bill on the date you choose, taking it back out of payables and inventory or expense."
                minDate={bill.billDate}
                defaultDate={now}
                needsDate
                onVoid={voidBillAction.bind(null, bill.id)}
              />
            ) : null}
          </>
        }
      />

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Lines</CardTitle>
              {bill.inventoryCents > 0 ? (
                <Badge tone="info">
                  <Money cents={bill.inventoryCents} plain /> capitalized to inventory
                </Badge>
              ) : null}
            </CardHeader>
            <div className="relative overflow-x-auto">
              <table className="w-full min-w-[40rem] border-separate border-spacing-0 text-sm">
                <thead>
                  <tr>
                    <Th className="w-8">#</Th>
                    <Th>Description</Th>
                    <Th>Account</Th>
                    <Th>Treatment</Th>
                    {showQty ? <Th align="right">Qty × cost</Th> : null}
                    <Th align="right">Amount</Th>
                  </tr>
                </thead>
                <tbody>
                  {bill.lines.map((line) => (
                    <tr key={line.lineNo}>
                      <Td className="num text-xs text-muted-foreground">{line.lineNo}</Td>
                      <Td>{line.description}</Td>
                      <Td className="text-xs">{line.accountLabel}</Td>
                      <Td>
                        {line.isInventory ? (
                          <Badge tone="info" size="sm">
                            Inventory
                          </Badge>
                        ) : (
                          <Badge tone="neutral" size="sm">
                            Expense
                          </Badge>
                        )}
                      </Td>
                      {showQty ? (
                        <Td align="right" className="num text-xs text-muted-foreground">
                          {line.quantity !== null && line.unitCostCents !== null
                            ? `${line.quantity.replace(/\.?0+$/, '')} × ${formatCents(line.unitCostCents)}`
                            : ''}
                        </Td>
                      ) : null}
                      <Td align="right">
                        <Money cents={line.amountCents} />
                      </Td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={showQty ? 5 : 4} className="rule-subtotal rule-total px-3 py-1.5 font-semibold">
                      Total
                    </td>
                    <td className="rule-subtotal rule-total px-3 py-1.5 text-right font-semibold">
                      <Money cents={bill.totalCents} currency />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            {bill.memo ? <p className="border-t border-border px-4 py-3 text-sm text-muted-foreground">{bill.memo}</p> : null}
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>In the books</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-3">
                <Fact label="Ledger">
                  {bill.journalEntryId ? (
                    <Link href={`/ledger/${bill.journalEntryId}`} className="num text-primary hover:underline">
                      Entry #{bill.journalEntryNo}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">Not posted</span>
                  )}
                </Fact>
                <Fact label="Our PO">{bill.poNumber ?? <span className="text-muted-foreground">—</span>}</Fact>
                <Fact label="Total">
                  <Money cents={bill.totalCents} plain />
                </Fact>
                <Fact label="Open">
                  <Money cents={bill.status === 'void' || bill.status === 'draft' ? 0 : bill.balanceCents} plain className="font-semibold" />
                </Fact>
              </dl>
              {bill.status === 'draft' ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  Not in the books yet. Approving posts each line to its account — inventory lines to the balance sheet —
                  against 2000 Accounts Payable, with {bill.vendorName} on every line.
                </p>
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Payments and credits</CardTitle>
            </CardHeader>
            {bill.settlements.length === 0 ? (
              <p className="px-4 py-4 text-xs text-muted-foreground">
                {open ? 'Nothing paid yet.' : 'None.'}
              </p>
            ) : (
              <ul className="flex flex-col">
                {bill.settlements.map((s) => (
                  <li key={`${s.kind}-${s.id}-${s.date}-${s.amountCents}`} className="rule-row flex items-baseline justify-between gap-3 px-4 py-2 text-sm">
                    <span>
                      {s.kind === 'bill_payment' ? (
                        <Link href={`/purchases/payments/${s.id}`} className="num text-primary hover:underline">
                          {s.docNo}
                        </Link>
                      ) : (
                        <span className="num">{s.docNo}</span>
                      )}
                      <span className="num block text-2xs text-muted-foreground">
                        {s.date}
                        {s.void ? ' · void' : ''}
                      </span>
                    </span>
                    <Money cents={s.amountCents} plain className={s.void ? 'text-muted-foreground line-through' : undefined} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
