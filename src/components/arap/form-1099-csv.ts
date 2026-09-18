/**
 * The 1099-NEC workpaper as CSV: one row per vendor, flagged vendors first,
 * then the unflagged ones worth reviewing. Money is written as plain decimals
 * from integer cents, never through a float.
 */

import { formatMoneyPlain } from '@/lib/money';

export interface Csv1099Row {
  vendorName: string;
  legalName: string | null;
  taxIdLast4: string | null;
  is1099: boolean;
  w9OnFile: boolean;
  w9ReceivedAt: string | null;
  billPaymentCents: number;
  directPaymentCents: number;
  cardPaymentCents: number;
  reportableCents: number;
  status: string;
}

export const STATUS_1099_LABELS: Readonly<Record<string, string>> = {
  file: 'File a 1099-NEC',
  needs_w9: 'Over threshold — get a W-9',
  below_threshold: 'Below threshold',
  review_flag: 'Review: not flagged, looks like a contractor',
};

function cell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function form1099Csv(year: number, thresholdCents: number, rows: readonly Csv1099Row[]): string {
  const header = [
    'Tax year',
    'Vendor',
    'Legal name',
    'TIN last 4',
    'Flagged 1099',
    'W-9 on file',
    'W-9 received',
    'Bill payments',
    'Direct payments',
    'Reportable total',
    'Paid by card (excluded)',
    'Threshold',
    'Status',
  ];
  const lines = [header.map(cell).join(',')];
  for (const row of rows) {
    lines.push(
      [
        String(year),
        row.vendorName,
        row.legalName ?? '',
        row.taxIdLast4 ?? '',
        row.is1099 ? 'yes' : 'no',
        row.w9OnFile ? 'yes' : 'no',
        row.w9ReceivedAt ?? '',
        formatMoneyPlain(row.billPaymentCents),
        formatMoneyPlain(row.directPaymentCents),
        formatMoneyPlain(row.reportableCents),
        formatMoneyPlain(row.cardPaymentCents),
        formatMoneyPlain(thresholdCents),
        STATUS_1099_LABELS[row.status] ?? row.status,
      ]
        .map(cell)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}
