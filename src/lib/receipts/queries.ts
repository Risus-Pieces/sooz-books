import { sql } from 'drizzle-orm';

import type { LedgerDb } from '@/lib/ledger/post';

import type { ProposalLine, ProposalStatus, ProposalView, ReceiptWarning } from './types';

/** One proposal as the database returns it from a raw query: bigints as text, jsonb possibly as text. */
export type ProposalRow = {
  id: string;
  status: ProposalStatus;
  attachment_id: string;
  filename: string;
  vendor_id: string | null;
  vendor_name: string | null;
  receipt_date: string | null;
  total_cents: string | number | null;
  payer_id: string | null;
  lines: ProposalLine[] | string;
  warnings: ReceiptWarning[] | string;
  error: string | null;
  entry_id: string | null;
  entry_no: string | number | null;
};

const asArray = <T>(value: unknown): T[] =>
  typeof value === 'string' ? (JSON.parse(value) as T[]) : ((value ?? []) as T[]);

export function toView(row: ProposalRow, labels: ReadonlyMap<string, string>): ProposalView {
  const lines = asArray<ProposalLine>(row.lines);
  const warnings = asArray<ReceiptWarning>(row.warnings);
  const totalCents = row.total_cents === null ? null : Number(row.total_cents);

  return {
    id: row.id,
    status: row.status,
    attachmentId: row.attachment_id,
    filename: row.filename,
    vendorName: row.vendor_name,
    vendorIsNew: row.vendor_id === null && row.vendor_name !== null,
    date: row.receipt_date,
    totalCents,
    payerId: row.payer_id,
    lines: lines.map((line) => ({
      description: line.description,
      cents: line.cents,
      accountId: line.accountId,
      accountLabel: line.accountId === null ? null : (labels.get(line.accountId) ?? null),
    })),
    warnings,
    error: row.error,
    entryId: row.entry_id,
    entryNo: row.entry_no === null ? null : Number(row.entry_no),
    needsConfirmation: warnings.some((w) => w.code === 'possible_duplicate'),
    canPost:
      row.status === 'proposed' &&
      !warnings.some((w) => w.blocking) &&
      row.payer_id !== null &&
      lines.length > 0 &&
      lines.every((line) => line.accountId !== null) &&
      totalCents !== null &&
      totalCents > 0 &&
      row.receipt_date !== null,
  };
}

const idList = (ids: readonly string[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

export async function loadProposalViews(exec: LedgerDb, ids: readonly string[]): Promise<ProposalView[]> {
  if (ids.length === 0) return [];

  const rows = await exec.execute<ProposalRow>(sql`
    select rp.id, rp.status, rp.attachment_id, a.filename, rp.vendor_id, rp.vendor_name,
           rp.receipt_date::text as receipt_date, rp.total_cents, rp.payer_id,
           rp.lines, rp.warnings, rp.error, rp.entry_id, e.entry_no
      from receipt_proposals rp
      join attachments a on a.id = rp.attachment_id
      left join journal_entries e on e.id = rp.entry_id
     where rp.id in (${idList(ids)})
     order by rp.created_at, rp.id`);

  const accountIds = [
    ...new Set(
      rows.flatMap((r) => asArray<ProposalLine>(r.lines).map((l) => l.accountId)).filter((id): id is string => id !== null),
    ),
  ];
  const labels = new Map<string, string>();
  if (accountIds.length > 0) {
    const accounts = await exec.execute<{ id: string; code: string; name: string }>(
      sql`select id, code, name from accounts where id in (${idList(accountIds)})`,
    );
    for (const account of accounts) labels.set(account.id, `${account.name} (${account.code})`);
  }

  return rows.map((row) => toView(row, labels));
}

export async function loadProposalView(exec: LedgerDb, id: string): Promise<ProposalView | null> {
  const [view] = await loadProposalViews(exec, [id]);
  return view ?? null;
}

/** Proposals still waiting for a person, oldest first. */
export async function listWaitingViews(exec: LedgerDb, limit = 50): Promise<ProposalView[]> {
  const rows = await exec.execute<{ id: string }>(
    sql`select id from receipt_proposals where status = 'proposed' order by created_at, id limit ${limit}`,
  );
  return loadProposalViews(exec, rows.map((r) => r.id));
}
