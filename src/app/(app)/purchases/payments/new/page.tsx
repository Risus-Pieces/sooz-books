import type { Metadata } from 'next';

import { MoneyDocForm } from '@/components/arap/money-doc-form';
import { formatCents } from '@/components/ui/money';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';
import { today } from '@/lib/dates';

import { isUuid } from '../../../sales/queries';
import { openBillsFor, paymentAccountOptions, vendorPicks, vendorsWithOpenBills } from '../../queries';

export const metadata: Metadata = { title: 'Pay bills' };

type SearchParams = Record<string, string | string[] | undefined>;

export default async function PayBillsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [user, raw] = await Promise.all([requireUser('/purchases/payments/new'), searchParams]);
  const vendorId = typeof raw.vendor === 'string' && isUuid(raw.vendor) ? raw.vendor : null;
  const billId = typeof raw.bill === 'string' && isUuid(raw.bill) ? raw.bill : null;

  const [vendors, owed, accounts, openDocs] = await Promise.all([
    vendorPicks(),
    vendorsWithOpenBills(),
    paymentAccountOptions(),
    vendorId === null ? Promise.resolve([]) : openBillsFor(vendorId),
  ]);
  const owedById = new Map(owed.map((o) => [o.id, o]));
  // Vendors with money owed first, oldest due first; then everyone else by name.
  const ordered = [
    ...owed.map((o) => vendors.find((v) => v.id === o.id)).filter((v) => v !== undefined),
    ...vendors.filter((v) => !owedById.has(v.id)),
  ];
  const operating = accounts.find((a) => a.label.includes('9726')) ?? accounts[0] ?? null;

  return (
    <MoneyDocForm
        toolbar={{
          title: 'Pay bills',
          back: { href: '/purchases/payments', label: 'Payments' },
          info: (
            <p>
              One payment to one vendor can settle several of their bills. Paying from a card account marks it
              card-paid, which keeps it off the 1099.
            </p>
          ),
        }}
        side="ap"
        parties={ordered.map((v) => {
          const o = owedById.get(v.id);
          return { id: v.id, name: v.name, note: o ? `${formatCents(o.openCents, { currency: true })} open` : undefined };
        })}
        partyId={vendors.some((v) => v.id === vendorId) ? vendorId : null}
        openDocs={openDocs}
        accounts={accounts}
        defaultAccountId={operating?.id ?? null}
        today={today()}
        preselect={billId === null ? [] : [billId]}
        canSubmit={can(user.role, 'ap.pay')}
      />
  );
}
