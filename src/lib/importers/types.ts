/**
 * The importer contract — `docs/formats/README.md` §1.2, adapted to what the
 * parser layer in `@/lib/banking` actually produces.
 *
 * Six sources that look nothing alike decompose into the same five stages, and
 * each stage fails the same way in all six: identify the file, parse it to typed
 * rows without letting one bad row cost the file, fingerprint each row so
 * re-import is idempotent, assert the source's own arithmetic identity, and only
 * then produce postable entries. This module is that contract.
 *
 * Four deliberate departures from the document, each because the document's shape
 * fights the code that already exists:
 *
 *  1. **`ParsedFile` is `@/lib/banking/types`' `ParsedFile`, not the document's.**
 *     The document imagines an importer that receives raw bytes and decodes them
 *     itself. `readFile()` already does that job — it sniffs the format from the
 *     magic bytes rather than the extension, rejects a PDF or an HTML login page
 *     by name, decodes the text and hands back a rectangle of trimmed strings
 *     with the sha256 of the original bytes attached. An importer that re-decoded
 *     would be a second, worse copy of it. `SourceFile` carries the few things
 *     that survive only on the raw upload — the bytes themselves and how they
 *     arrived — for the importers that need them.
 *
 *  2. **`fingerprint` takes a context.** The document writes
 *     `fingerprint(row): string`, but every bank fingerprint in §3.3 is scoped to
 *     an account id, and a row does not know which account it is being imported
 *     into. Passing the scope explicitly is the difference between a key that is
 *     unique and one that collides across two accounts of the same company.
 *
 *  3. **`parse` returns the balance chain.** For a bank file the chain *is* the
 *     §1.4 assertion, and it is also what produces the chronological order that
 *     the occurrence index depends on. Recomputing it in `preview` would mean
 *     ordering the rows twice and risking two different answers.
 *
 *  4. **`toEntries` is optional.** For a settlement file — Shopify, Amazon, Faire
 *     — the journal entry is a function of the rows: the file states the gross
 *     sale, the fee and the net, so `toEntries(rows, ctx)` is total. For a bank
 *     statement it is not, and cannot be made so: the file says `-8.19 Target`
 *     and says nothing whatever about which account that belongs in. The contra
 *     account comes from a rule, a vendor default or a human in the review queue,
 *     none of which is in `TRow`. A bank importer's output is therefore a
 *     reviewed `bank_transactions` row, and the entry is built later from that
 *     row plus the decision recorded against it. Declaring `toEntries` required
 *     and implementing it as a throw would be a lie in the type system.
 */

import type { CalendarDate } from '@/lib/dates';

import type {
  BalanceChainResult,
  ImportProfile,
  NormalizedTxn,
  ParseWarning,
  ParsedFile,
  SkippedRow,
  WarningSeverity,
} from '@/lib/banking/types';

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

/**
 * `docs/formats/README.md` §1.3, one rung taller than the parser's own ladder.
 *
 * `@/lib/banking` stops at `error` because it works a row at a time and a row is
 * the largest thing it can lose. An importer can lose the whole file, so it needs
 * `fatal`: the file is not what it claims to be, or the parse is provably
 * incomplete. Nothing from a fatal file may be written.
 */
export type IssueSeverity = WarningSeverity | 'fatal';

export interface Issue {
  readonly severity: IssueSeverity;
  /** Stable and machine-readable: `date.unparsable`, `balance.chain_broken`. */
  readonly code: string;
  /** What a bookkeeper reads. */
  readonly message: string;
  /** 0-based index among the physical data rows. */
  readonly rowIndex?: number;
  /** The offending row verbatim. Always attached on `error` and `fatal`. */
  readonly rawRow?: readonly string[];
  readonly field?: string;
  /** What to do about it: "re-download the full month from the Statements tab". */
  readonly remedy?: string;
}

/** Lifts a parser warning into an importer issue. The two ladders agree below `fatal`. */
export function toIssue(warning: ParseWarning, remedy?: string): Issue {
  return {
    severity: warning.severity,
    code: warning.code,
    message: warning.message,
    ...(warning.rowIndex === undefined ? {} : { rowIndex: warning.rowIndex }),
    ...(warning.field === undefined ? {} : { field: warning.field }),
    ...(remedy === undefined ? {} : { remedy }),
  };
}

/** A skipped row, as an issue that names the raw text so nothing vanishes silently. */
export function skippedToIssue(skipped: SkippedRow): Issue {
  return {
    severity: 'error',
    code: skipped.code,
    message: skipped.reason,
    rowIndex: skipped.rowIndex,
    rawRow: skipped.cells,
  };
}

/** True when any issue would stop the file from being written at all. */
export function hasFatal(issues: readonly Issue[]): boolean {
  return issues.some((issue) => issue.severity === 'fatal');
}

/** The import report's headline: how many of each severity. §1.3, point 6. */
export function countBySeverity(issues: readonly Issue[]): Record<IssueSeverity, number> {
  const counts: Record<IssueSeverity, number> = { info: 0, warn: 0, error: 0, fatal: 0 };
  for (const issue of issues) counts[issue.severity] += 1;
  return counts;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** How a file reached us. Emailed exports and portal downloads fail differently. */
export type Delivery = 'upload' | 'email-attachment' | 'api' | 'sftp';

/**
 * The raw upload, kept beside the decoded grid.
 *
 * The bytes are retained deliberately: a fingerprint recipe that changes has to
 * be recomputable years later without asking anyone to re-upload a file they no
 * longer have (§3.3). `sha256` is the layer-0 deduplication key and is computed
 * before anything is parsed.
 */
export interface SourceFile {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  /** Advisory only; the format is sniffed from the bytes. Still load-bearing for Relay, whose filename carries the account and the period. */
  readonly filename: string;
  readonly delivery: Delivery;
  readonly receivedAt: string;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Why an importer was or was not offered. Confidence bands from §1.2: `>= 0.90`
 * auto-selects, `0.50`–`0.90` is offered with the reasons shown, below `0.50` is
 * not offered at all. Two importers must never auto-select at the same
 * confidence — the caller asks instead.
 */
export interface DetectionResult {
  readonly importerId: string;
  readonly label: string;
  /** 0..1. */
  readonly confidence: number;
  /** Human-readable, strongest first. Shown when confidence is low; logged always. */
  readonly reasons: readonly string[];
  /**
   * Set when the file is recognised but must not be imported. Detection is the
   * right place to refuse: a file named like a Relay export whose header is not
   * Relay's has been edited or re-saved, and guessing at its columns is worse
   * than stopping.
   */
  readonly rejection?: { readonly code: string; readonly message: string; readonly remedy: string };
  /** The bank account the file identifies itself as belonging to, when it can. */
  readonly accountMask?: string | null;
  /** The period the file claims to cover, from its own naming or contents. */
  readonly periodStart?: CalendarDate | null;
  readonly periodEnd?: CalendarDate | null;
  /**
   * True when the source says the period is still open. A partial month will be
   * re-downloaded complete, so its rows arrive twice by design.
   */
  readonly partial?: boolean;
}

export const AUTO_SELECT_CONFIDENCE = 0.9;
export const OFFER_CONFIDENCE = 0.5;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Facts hoisted out of the file that individual rows do not carry.
 *
 * For Relay every one of these comes from the filename or the balance column;
 * for Amazon the currency and the period live only on the summary row.
 */
export interface FileHeader {
  /** Last four of the account, the channel id, the settlement id — whatever identifies the container. */
  readonly accountOrChannelId: string | null;
  readonly currency: string;
  readonly periodStart: CalendarDate | null;
  readonly periodEnd: CalendarDate | null;
  /** The number §1.4's assertion ties to, when the file states one. */
  readonly controlTotalCents: number | null;
  readonly sortOrder: 'asc' | 'desc' | 'unsorted';
  /** True when the source says this period is not closed yet. */
  readonly partial: boolean;
}

/**
 * The minimum a row must carry to be written to `bank_transactions`.
 *
 * Structural on purpose: any importer whose rows have these fields satisfies it,
 * and none of them has to import this module to do so.
 */
export type ImportableRow = NormalizedTxn;

export interface ParseStats {
  /** Physical rows in the file, header included. */
  readonly physicalLines: number;
  /** Data rows seen, before skipping. */
  readonly dataRows: number;
  readonly skipped: number;
  /** Rows returned but unusable: they are shown, never written. */
  readonly unusable: number;
}

export interface ImporterParseResult<TRow extends ImportableRow> {
  /** Chronological, oldest first. The occurrence index depends on this order. */
  readonly rows: readonly TRow[];
  readonly issues: readonly Issue[];
  readonly header: FileHeader;
  /** Rows dropped before becoming transactions, with their reason and raw text. */
  readonly skipped: readonly SkippedRow[];
  readonly stats: ParseStats;
  /** The column mapping actually used, persisted with the batch. */
  readonly profile: ImportProfile;
  /**
   * The running-balance check. `null` for a format with no balance column;
   * present and authoritative for every bank file, where it is both the §1.4
   * identity and the source of the chronological order above.
   */
  readonly balanceChain: BalanceChainResult | null;
}

export interface ImporterContext {
  /** The account these rows are being imported into. Scopes every fingerprint. */
  readonly bankAccountId: string;
  /** Overrides the importer's built-in column mapping. */
  readonly profile?: ImportProfile;
  /** The mask the target account is known by, checked against the file's own. */
  readonly bankAccountMask?: string | null;
  /** What the account held before the first row, when it is known. */
  readonly openingBalanceCents?: number;
}

// ---------------------------------------------------------------------------
// Assertions — §1.4
// ---------------------------------------------------------------------------

/**
 * A source's own arithmetic identity, checked before anything is believed.
 *
 * An importer that cannot state its identity has not been finished. For a bank
 * file it is the running balance: if `balance[n] == balance[n-1] + amount[n]`
 * holds across the file, then every row parsed, every sign was read the right way
 * round, and nothing was dropped or doubled.
 */
export interface Assertion {
  readonly id: string;
  readonly label: string;
  readonly severity: 'fatal' | 'warn';
  readonly passed: boolean;
  readonly expectedCents: number;
  readonly actualCents: number;
  readonly differenceCents: number;
  readonly detail?: string;
}

// ---------------------------------------------------------------------------
// Preview — §1.4
// ---------------------------------------------------------------------------

export interface PreviewSummary {
  readonly rowCount: number;
  /** From the parsed rows, never from what the user said the file covers. */
  readonly dateRange: { readonly min: CalendarDate; readonly max: CalendarDate } | null;
  readonly totals: {
    readonly inflowCents: number;
    readonly outflowCents: number;
    readonly netCents: number;
  };
  readonly byType: ReadonlyArray<{
    readonly type: string;
    readonly count: number;
    readonly amountCents: number;
  }>;
  readonly assertions: readonly Assertion[];
  /** Rows that will post with a review flag rather than a decision. */
  readonly needsReview: number;
  /** Rows imported but barred from posting: a returned ACH moved no money. */
  readonly excluded: number;
}

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

export interface Importer<TRow extends ImportableRow> {
  readonly id: string;
  readonly label: string;

  /** Cheap, pure, and never throws. Runs against every registered importer. */
  detect(file: ParsedFile, source?: SourceFile): DetectionResult;

  /**
   * Never throws for a data reason — §1.3. A row whose date will not parse, whose
   * field count is wrong, or which is a footer total is skipped and reported with
   * its raw text; the rest of the file still imports. It throws only when the file
   * cannot be read at all.
   */
  parse(file: ParsedFile, ctx: ImporterContext): ImporterParseResult<TRow>;

  /** The stable per-row deduplication key, scoped to `ctx.bankAccountId`. */
  fingerprint(row: TRow, ctx: ImporterContext): string;

  /** The §1.4 summary, including every identity this importer asserts. */
  preview(rows: readonly TRow[], header: FileHeader, parsed?: ImporterParseResult<TRow>): PreviewSummary;

  /**
   * Drafts, never posted entries — and only for sources that carry their own
   * categorization. See the note at the head of this file for why a bank
   * statement importer does not implement this.
   *
   * The return is `unknown` rather than the ledger's `DraftEntry[]` on purpose:
   * posting is a later phase and `@/lib/ledger/post` is another module's to
   * shape. An importer that implements this narrows the return itself; nothing
   * here takes a compile-time dependency on a file it does not own.
   */
  toEntries?(rows: readonly TRow[]): unknown;
}
