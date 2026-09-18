import type { DraftLine } from '@/lib/ledger/post';

/**
 * A signed amount against an account: positive is a debit, negative a credit.
 * Built up freely, then turned into one-sided journal lines by `toDraftLines`.
 */
export interface SignedLine {
  accountId?: string;
  accountCode?: string;
  cents: number;
  memo?: string;
  productId?: string | null;
  channelId?: string | null;
  vendorId?: string | null;
}

function key(line: SignedLine): string {
  return [
    line.accountId ?? '',
    line.accountCode ?? '',
    line.productId ?? '',
    line.channelId ?? '',
    line.vendorId ?? '',
    line.memo ?? '',
  ].join('|');
}

/**
 * Nets lines that share an account, dimensions and memo; drops zeros; puts each
 * survivor on its own side. Order of first appearance is kept so an entry reads
 * the way it was built.
 */
export function toDraftLines(lines: readonly SignedLine[]): DraftLine[] {
  const merged = new Map<string, SignedLine>();
  for (const line of lines) {
    if (!Number.isSafeInteger(line.cents)) {
      throw new Error(`Line amount ${line.cents} is not a whole number of cents.`);
    }
    const k = key(line);
    const existing = merged.get(k);
    if (existing) existing.cents += line.cents;
    else merged.set(k, { ...line });
  }
  const out: DraftLine[] = [];
  for (const line of merged.values()) {
    if (line.cents === 0) continue;
    out.push({
      ...(line.accountId === undefined ? {} : { accountId: line.accountId }),
      ...(line.accountCode === undefined ? {} : { accountCode: line.accountCode }),
      ...(line.cents > 0 ? { debitCents: line.cents } : { creditCents: -line.cents }),
      ...(line.memo === undefined ? {} : { memo: line.memo }),
      productId: line.productId ?? null,
      channelId: line.channelId ?? null,
      vendorId: line.vendorId ?? null,
    });
  }
  return out;
}

export function totalDebits(lines: readonly DraftLine[]): number {
  return lines.reduce((sum, l) => sum + (l.debitCents ?? 0), 0);
}

export function totalCredits(lines: readonly DraftLine[]): number {
  return lines.reduce((sum, l) => sum + (l.creditCents ?? 0), 0);
}
