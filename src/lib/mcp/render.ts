/** How a staged change, and what became of it, is put in front of the person. */
import type { CommitResult } from './commit';
import { UNTRUSTED_NOTE, dollars, untrusted } from './format';
import type { AccountPreview, BankPreview, JournalPreview, Staged } from './stage';
import { STAGE_TTL_MINUTES } from './staging';

const SHOW_AND_ASK =
  'Nothing has been posted. Show the user the full preview below (every account debited and credited) and ask for their explicit approval. Call commit_staged only after they say yes to THIS stage; if they want anything changed, stage again.';

function header(stageId: string): string {
  return [`STAGED — stage_id: ${stageId} (valid for ${STAGE_TTL_MINUTES} minutes, single use)`, SHOW_AND_ASK].join('\n');
}

function lineText(line: { account: string; debitCents: number; creditCents: number }): string {
  return line.debitCents > 0
    ? `   Debit   ${line.account}   ${dollars(line.debitCents)}`
    : `   Credit  ${line.account}   ${dollars(line.creditCents)}`;
}

export function renderBankStage(staged: Staged<BankPreview>): string {
  const { entries, exclusions, problems } = staged.preview;
  const out: string[] = [];
  out.push(staged.stageId === null ? 'NOT STAGED — nothing could be staged.' : header(staged.stageId));
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

export function renderJournalStage(staged: Staged<JournalPreview>): string {
  const { preview } = staged;
  return [
    header(staged.stageId ?? ''),
    UNTRUSTED_NOTE,
    `\nWill post a manual journal entry dated ${preview.date}, total ${dollars(preview.totalCents)}. Memo: ${untrusted(preview.memo)}`,
    ...preview.lines.map((line) => `${lineText(line)}${line.memo === null ? '' : `   — ${untrusted(line.memo)}`}`),
  ].join('\n');
}

export function renderAccountStage(staged: Staged<AccountPreview>): string {
  const { preview } = staged;
  return [
    header(staged.stageId ?? ''),
    UNTRUSTED_NOTE,
    `\nWill create account ${preview.code} "${preview.name}" (${preview.type}${preview.subtype === null ? '' : `, reports as ${preview.subtype}`})${preview.parent === null ? ', top level' : `, under ${preview.parent}`}. Description: ${untrusted(preview.description)}`,
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
