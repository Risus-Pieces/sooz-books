/** How a staged change, and what became of it, is put in front of the person. */
import type { CommitResult } from './commit';
import { UNTRUSTED_NOTE, dollars, untrusted } from './format';
import type { AccountPreview, BankPreview, JournalPreview, Staged } from './stage';
import type { McpStaging } from '@/db/schema';

const SHOW_AND_ASK =
  'Nothing has been posted. Show the user the full preview below (every account debited and credited) and ask for their explicit approval. Call commit_staged only after they say yes to THIS stage; if they want anything changed, stage again.';

const LEFT_FOR_PERSON =
  'Nothing has been posted, and this key cannot post it. It waits for the person to review it and confirm it themselves while signed in (list_staged shows everything waiting).';

export interface RenderOptions {
  /** The stage was made by an agent's key, which cannot confirm it. */
  byKey?: boolean;
}

function validFor(expiresAt: Date | null): string {
  if (expiresAt === null) return 'single use';
  const minutes = Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 60_000));
  return minutes >= 120 ? `valid for about ${Math.round(minutes / 60)} hours, single use` : `valid for ${minutes} minutes, single use`;
}

function header(staged: { stageId: string | null; expiresAt: Date | null }, options: RenderOptions = {}): string {
  return [
    `STAGED — stage_id: ${staged.stageId ?? ''} (${validFor(staged.expiresAt)})`,
    options.byKey === true ? LEFT_FOR_PERSON : SHOW_AND_ASK,
  ].join('\n');
}

function lineText(line: { account: string; debitCents: number; creditCents: number }): string {
  return line.debitCents > 0
    ? `   Debit   ${line.account}   ${dollars(line.debitCents)}`
    : `   Credit  ${line.account}   ${dollars(line.creditCents)}`;
}

export function renderBankStage(staged: Staged<BankPreview>, options: RenderOptions = {}): string {
  const { entries, exclusions, problems } = staged.preview;
  const out: string[] = [];
  out.push(staged.stageId === null ? 'NOT STAGED — nothing could be staged.' : header(staged, options));
  out.push(UNTRUSTED_NOTE);

  if (entries.length > 0) {
    out.push(`\nWill post ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}:`);
    entries.forEach((entry, index) => {
      out.push(
        `${index + 1}. ${entry.date} · ${entry.bank} · ${dollars(entry.amountCents)}${entry.action === 'personal' ? ' · PERSONAL (owner draw)' : ''}`,
        `   Bank text: ${untrusted(entry.description)} · Memo: ${untrusted(entry.memo)}${entry.vendor === null ? '' : ` · Vendor: ${untrusted(entry.vendor)}`}`,
        ...entry.warnings.map((warning) => `   ${untrusted(warning)} ← tell the user about this`),
        ...entry.lines.map(lineText),
        `   (txn ${entry.txnId})`,
      );
    });
  }
  if (exclusions.length > 0) {
    out.push(`\nWill mark ${exclusions.length} as excluded (the money never moved; no entry is posted):`);
    exclusions.forEach((row, index) =>
      out.push(`${index + 1}. ${row.date} · ${row.bank} · ${dollars(row.amountCents)} · ${untrusted(row.description)} (txn ${row.txnId})`),
    );
  }
  if (problems.length > 0) {
    out.push(`\nCould not stage ${problems.length} (left out of this stage — fix and stage them again):`);
    problems.forEach((problem) => out.push(`- txn ${problem.txnId}: ${untrusted(problem.reason)}`));
  }
  return out.join('\n');
}

export function renderJournalStage(staged: Staged<JournalPreview>, options: RenderOptions = {}): string {
  const { preview } = staged;
  return [
    header(staged, options),
    UNTRUSTED_NOTE,
    `\nWill post a manual journal entry dated ${preview.date}, total ${dollars(preview.totalCents)}. Memo: ${untrusted(preview.memo)}`,
    ...preview.lines.map((line) => `${lineText(line)}${line.memo === null ? '' : `   — ${untrusted(line.memo)}`}`),
  ].join('\n');
}

export function renderAccountStage(staged: Staged<AccountPreview>, options: RenderOptions = {}): string {
  const { preview } = staged;
  return [
    header(staged, options),
    UNTRUSTED_NOTE,
    `\nWill create account ${untrusted(preview.code)} ${untrusted(preview.name)} (${preview.type}${preview.subtype === null ? '' : `, reports as ${preview.subtype}`})${preview.parent === null ? ', top level' : `, under ${preview.parent}`}. Description: ${untrusted(preview.description)}`,
    ...preview.warnings.map((warning) => `WARNING: ${warning}`),
  ].join('\n');
}

export function renderCommit(done: CommitResult): string {
  switch (done.kind) {
    case 'journal_entry':
      return `Posted. Journal entry #${done.result.entryNo} is in the ledger.`;
    case 'new_account':
      return `Created account ${done.result.code}.`;
    case 'bank_decisions': {
      const { posted, excluded, failed } = done.result;
      return [
        `Done. Posted ${posted.length}, excluded ${excluded.length}, could not do ${failed.length}.`,
        ...posted.map((p) => `- posted entry #${p.entryNo} (txn ${p.txnId})`),
        ...failed.map((f) => `- NOT done, txn ${f.txnId}: ${untrusted(f.reason)}`),
        failed.length > 0 ? 'This stage is used up. Tell the user which ones failed and stage those again if they still want them.' : '',
      ]
        .filter(Boolean)
        .join('\n');
    }
  }
}

/** A stored stage, rendered as it was when it was made. */
export function renderStoredStage(row: Pick<McpStaging, 'id' | 'kind' | 'preview' | 'expiresAt' | 'clientId'>): string {
  const staged = { stageId: row.id, expiresAt: row.expiresAt };
  const madeBy = row.clientId?.startsWith('key:') ? `Prepared by the key ${untrusted(row.clientId.slice(4))}.\n` : '';
  switch (row.kind) {
    case 'bank_decisions':
      return madeBy + renderBankStage({ ...staged, preview: row.preview as BankPreview });
    case 'journal_entry':
      return madeBy + renderJournalStage({ ...staged, preview: row.preview as JournalPreview });
    case 'new_account':
      return madeBy + renderAccountStage({ ...staged, preview: row.preview as AccountPreview });
  }
}
