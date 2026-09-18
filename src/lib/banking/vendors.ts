/**
 * Sooz Books — resolving a bank statement payee to a vendor.
 *
 * Bank payees are dirty in ways that are entirely predictable once you have read a
 * few thousand of them: a payment processor stamps its own prefix on the front
 * (`SP+AFF * META STORE -`), a merchant appends its terminal or order id to the back
 * (`FEDEX533300619`, `eBay O*22-14335-69339`), and the same company shows up under
 * three spellings in the same statement (`GOOGLE`, `Google`).
 *
 * Resolution happens in four tiers, most trustworthy first:
 *
 *   1. **`alias_exact`** — the normalised payee is a `vendor_aliases.alias_normalized`
 *      verbatim. This is what `learnAlias` feeds, so every confirmed spelling
 *      resolves here for ever after, at confidence 1.0.
 *   2. **`alias_cleaned`** — `vendorMatchKey` reduces both sides to the merchant's
 *      name (processor prefix, trailing reference, legal suffix removed) and the
 *      results agree.
 *   3. **`vendor_name`** — the same reduced form equals a vendor's name.
 *   4. **`fuzzy`** — Jaro-Winkler similarity above a floor, and clear of the
 *      runner-up by a margin. Below the floor, or when two vendors are equally
 *      close, the answer is "no match", which is a perfectly good answer: the
 *      review queue exists for exactly this.
 *
 * Jaro-Winkler is computed locally rather than in Postgres. `pg_trgm` is not
 * installed on this database, and enabling an extension is a schema change this
 * module does not need: the vendor list is 32 rows, the alias list 37, and the whole
 * index fits in memory many times over.
 */

import { sql as sqlTag } from 'drizzle-orm';

import type { Tx } from '@/db/client';

import { cleanPayee, normalizeDescription } from './normalize';

// ---------------------------------------------------------------------------
// The matching key
// ---------------------------------------------------------------------------

/** Legal-entity suffixes. Stripped from the back, repeatedly (`COMPANY LLC`). */
const LEGAL_SUFFIXES: ReadonlySet<string> = new Set([
  'INC',
  'INCORPORATED',
  'LLC',
  'LLP',
  'LP',
  'LTD',
  'LIMITED',
  'CO',
  'CORP',
  'CORPORATION',
  'COMPANY',
  'PLC',
  'GMBH',
  'SA',
  'NV',
  'BV',
  'SRL',
  'PTY',
]);

/** Dangling connectives left behind once a truncated suffix is removed. */
const TRAILING_STOPWORDS: ReadonlySet<string> = new Set(['AND', 'OF', 'THE', 'FOR']);

/**
 * Reduces a payee to the part that identifies the merchant, for matching only.
 *
 * `cleanPayee` (in `./normalize`) has already removed what the payment network
 * added: the processor prefix, the trailing reference number, Relay's "Sent By"
 * metadata. This goes one step further, and only for comparison: it upper-cases
 * through `normalizeDescription`, then drops legal-entity suffixes, order numbers
 * and the single-character crumbs a truncated statement field leaves behind.
 *
 * The same reduction is applied to both sides of every comparison, so
 * `PAK-MAN PACKAGING AND S` and `Pak-Man Packaging` meet at `PAK MAN PACKAGING`.
 * It is never shown to anyone — display uses `cleanPayee().name`, which keeps the
 * merchant's own capitalisation.
 *
 * Returns the plain normalised form when reduction would leave nothing behind.
 */
export function vendorMatchKey(raw: string | null | undefined): string {
  const normalized = normalizeDescription(cleanPayee(raw).name);
  if (normalized === '') return '';

  let tokens = normalized.split(' ');

  // Standalone numeric runs are order and terminal ids, except a leading one that
  // is part of the name ("7 ELEVEN").
  tokens = tokens.filter((token, index) => index === 0 || !/^\d+$/.test(token));

  // Legal suffixes, single-character crumbs and dangling connectives.
  let changed = true;
  while (changed && tokens.length > 1) {
    changed = false;
    const last = tokens[tokens.length - 1];
    if (LEGAL_SUFFIXES.has(last) || TRAILING_STOPWORDS.has(last) || last.length === 1) {
      tokens = tokens.slice(0, -1);
      changed = true;
    }
  }

  const key = tokens.join(' ').trim();
  return key === '' ? normalized : key;
}

// ---------------------------------------------------------------------------
// String similarity
// ---------------------------------------------------------------------------

/** Jaro similarity: 0 for nothing in common, 1 for identical. */
export function jaro(a: string, b: string): number {
  if (a === '' && b === '') return 1;
  if (a === '' || b === '') return 0;
  if (a === b) return 1;

  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    const from = Math.max(0, i - window);
    const to = Math.min(i + window + 1, b.length);
    for (let j = from; j < to; j += 1) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }

  const half = transpositions / 2;
  return (matches / a.length + matches / b.length + (matches - half) / matches) / 3;
}

/**
 * Jaro-Winkler: Jaro, boosted when the strings share a prefix. Merchant names
 * diverge at the end far more often than at the start (`Bulk Supplement` vs
 * `Bulk Supplements`), which is exactly the bias the prefix boost encodes.
 */
export function jaroWinkler(a: string, b: string, prefixScale = 0.1): number {
  const base = jaro(a, b);
  if (base === 0) return 0;
  let prefix = 0;
  const limit = Math.min(4, a.length, b.length);
  while (prefix < limit && a[prefix] === b[prefix]) prefix += 1;
  return base + prefix * prefixScale * (1 - base);
}

/** Levenshtein edit distance. Exported for callers that want a raw distance. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a === '') return b.length;
  if (b === '') return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, substitution);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length];
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

export interface VendorRecord {
  readonly id: string;
  readonly name: string;
  readonly displayName: string | null;
  readonly vendorType: string;
  readonly defaultExpenseAccountId: string | null;
  readonly active: boolean;
}

export interface VendorAliasRecord {
  readonly id: string;
  readonly vendorId: string;
  readonly alias: string;
  readonly aliasNormalized: string;
  readonly source: string;
}

export type VendorCandidateKind = 'alias' | 'name' | 'display_name';

export interface VendorCandidate {
  readonly vendorId: string;
  readonly kind: VendorCandidateKind;
  /** The alias or name as written, for the reasoning string. */
  readonly label: string;
  readonly normalized: string;
  readonly cleaned: string;
}

export interface VendorIndex {
  readonly vendors: ReadonlyMap<string, VendorRecord>;
  readonly candidates: readonly VendorCandidate[];
  /** Tier 1: `alias_normalized` verbatim. */
  readonly byAliasNormalized: ReadonlyMap<string, readonly VendorCandidate[]>;
  /** Tiers 2 and 3: the `vendorMatchKey` of an alias, vendor name or display name. */
  readonly byCleaned: ReadonlyMap<string, readonly VendorCandidate[]>;
}

function push(
  map: Map<string, VendorCandidate[]>,
  key: string,
  candidate: VendorCandidate,
): void {
  if (key === '') return;
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, [candidate]);
  else bucket.push(candidate);
}

export function buildVendorIndex(
  vendors: readonly VendorRecord[],
  aliases: readonly VendorAliasRecord[],
): VendorIndex {
  const byId = new Map<string, VendorRecord>(vendors.map((vendor) => [vendor.id, vendor]));
  const candidates: VendorCandidate[] = [];
  const byAliasNormalized = new Map<string, VendorCandidate[]>();
  const byCleaned = new Map<string, VendorCandidate[]>();

  for (const alias of aliases) {
    if (!byId.has(alias.vendorId)) continue;
    const normalized = alias.aliasNormalized || normalizeDescription(alias.alias);
    const candidate: VendorCandidate = {
      vendorId: alias.vendorId,
      kind: 'alias',
      label: alias.alias,
      normalized,
      cleaned: vendorMatchKey(alias.alias),
    };
    candidates.push(candidate);
    push(byAliasNormalized, normalized, candidate);
    push(byCleaned, candidate.cleaned, candidate);
  }

  for (const vendor of vendors) {
    const nameCandidate: VendorCandidate = {
      vendorId: vendor.id,
      kind: 'name',
      label: vendor.name,
      normalized: normalizeDescription(vendor.name),
      cleaned: vendorMatchKey(vendor.name),
    };
    candidates.push(nameCandidate);
    push(byCleaned, nameCandidate.cleaned, nameCandidate);

    if (vendor.displayName !== null && vendor.displayName !== vendor.name) {
      const displayCandidate: VendorCandidate = {
        vendorId: vendor.id,
        kind: 'display_name',
        label: vendor.displayName,
        normalized: normalizeDescription(vendor.displayName),
        cleaned: vendorMatchKey(vendor.displayName),
      };
      candidates.push(displayCandidate);
      push(byCleaned, displayCandidate.cleaned, displayCandidate);
    }
  }

  return { vendors: byId, candidates, byAliasNormalized, byCleaned };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export type VendorMatchMethod = 'alias_exact' | 'alias_cleaned' | 'vendor_name' | 'fuzzy';

export interface VendorMatch {
  readonly vendorId: string;
  readonly vendorName: string;
  readonly defaultExpenseAccountId: string | null;
  readonly method: VendorMatchMethod;
  /** 0..1. Deterministic tiers score above anything fuzzy can reach. */
  readonly confidence: number;
  /** The alias or name that matched, for the suggestion's reasoning. */
  readonly matchedOn: string;
}

export interface ResolveVendorOptions {
  /** Below this Jaro-Winkler score nothing is returned. */
  readonly minFuzzyScore?: number;
  /** The best fuzzy candidate must beat the next vendor by this much. */
  readonly ambiguityMargin?: number;
  /** Fuzzy matching is not attempted on payees shorter than this. */
  readonly minFuzzyLength?: number;
}

const DEFAULT_MIN_FUZZY_SCORE = 0.88;
const DEFAULT_AMBIGUITY_MARGIN = 0.02;
const DEFAULT_MIN_FUZZY_LENGTH = 5;

/** The ceiling on a fuzzy score, so a guess never outranks a confirmed alias. */
const FUZZY_CONFIDENCE_CEILING = 0.9;

function singleVendor(bucket: readonly VendorCandidate[]): VendorCandidate | null {
  const first = bucket[0];
  if (first === undefined) return null;
  // Two vendors laying claim to the same spelling is a data problem, not something
  // to guess at. Fall through and let the review queue see it.
  return bucket.every((candidate) => candidate.vendorId === first.vendorId) ? first : null;
}

function toMatch(
  index: VendorIndex,
  candidate: VendorCandidate,
  method: VendorMatchMethod,
  confidence: number,
): VendorMatch | null {
  const vendor = index.vendors.get(candidate.vendorId);
  if (vendor === undefined) return null;
  return {
    vendorId: vendor.id,
    vendorName: vendor.name,
    defaultExpenseAccountId: vendor.defaultExpenseAccountId,
    method,
    confidence,
    matchedOn: candidate.label,
  };
}

/**
 * Resolves a raw statement payee to a vendor, or to null when nothing is close
 * enough to act on without a human.
 *
 * Null is a real answer here, not a failure. `CHASE COLLEGE` and
 * `Adv SafeBalance Banking` are the owner's personal bank accounts, `Owner's Comp`
 * is a Relay sub-account, and none of them is a vendor at all — inventing one for
 * them would be worse than leaving the field empty.
 */
export function resolveVendor(
  payee: string | null | undefined,
  index: VendorIndex,
  options: ResolveVendorOptions = {},
): VendorMatch | null {
  const normalized = normalizeDescription(payee);
  if (normalized === '') return null;
  const cleaned = vendorMatchKey(payee);

  // Tier 1 — a confirmed alias, verbatim.
  const aliasBucket = index.byAliasNormalized.get(normalized);
  if (aliasBucket !== undefined) {
    const candidate = singleVendor(aliasBucket);
    if (candidate !== null) {
      const match = toMatch(index, candidate, 'alias_exact', 1);
      if (match !== null) return match;
    }
  }

  // Tiers 2 and 3 — the cleaned forms agree. Aliases outrank bare vendor names.
  const cleanedBucket = index.byCleaned.get(cleaned);
  if (cleanedBucket !== undefined) {
    const candidate = singleVendor(cleanedBucket);
    if (candidate !== null) {
      const isAlias = candidate.kind === 'alias';
      const match = toMatch(
        index,
        candidate,
        isAlias ? 'alias_cleaned' : 'vendor_name',
        isAlias ? 0.95 : 0.92,
      );
      if (match !== null) return match;
    }
  }

  // Tier 4 — fuzzy, with a floor and an ambiguity guard.
  const minScore = options.minFuzzyScore ?? DEFAULT_MIN_FUZZY_SCORE;
  const margin = options.ambiguityMargin ?? DEFAULT_AMBIGUITY_MARGIN;
  const minLength = options.minFuzzyLength ?? DEFAULT_MIN_FUZZY_LENGTH;
  if (cleaned.length < minLength) return null;

  const bestByVendor = new Map<string, { score: number; candidate: VendorCandidate }>();
  for (const candidate of index.candidates) {
    const score = Math.max(
      jaroWinkler(normalized, candidate.normalized),
      jaroWinkler(cleaned, candidate.cleaned),
    );
    const existing = bestByVendor.get(candidate.vendorId);
    if (existing === undefined || score > existing.score) {
      bestByVendor.set(candidate.vendorId, { score, candidate });
    }
  }

  const ranked = [...bestByVendor.values()].sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (best === undefined || best.score < minScore) return null;
  const runnerUp = ranked[1];
  if (runnerUp !== undefined && best.score - runnerUp.score < margin) return null;

  return toMatch(
    index,
    best.candidate,
    'fuzzy',
    Math.min(FUZZY_CONFIDENCE_CEILING, Number(best.score.toFixed(3))),
  );
}

// ---------------------------------------------------------------------------
// Database access
// ---------------------------------------------------------------------------

interface VendorRow {
  readonly id: string;
  readonly name: string;
  readonly display_name: string | null;
  readonly vendor_type: string;
  readonly default_expense_account_id: string | null;
  readonly active: boolean;
}

interface AliasRow {
  readonly id: string;
  readonly vendor_id: string;
  readonly alias: string;
  readonly alias_normalized: string | null;
  readonly source: string;
}

export interface LoadVendorIndexOptions {
  readonly includeInactive?: boolean;
  /**
   * Read inside the caller's transaction instead of on a pooled connection.
   *
   * Required whenever the caller already holds a transaction: waiting on a second
   * pooled connection while holding the first deadlocks as soon as the pool is
   * exhausted — with a one-connection pool, on the very first import.
   */
  readonly tx?: Tx;
}

/**
 * Builds the index from the live tables.
 *
 * `@/db/client` opens its pool on import, so it is required lazily: everything
 * above this line is pure and runs with no database in reach.
 */
export async function loadVendorIndex(
  options: LoadVendorIndexOptions = {},
): Promise<VendorIndex> {
  const includeInactive = options.includeInactive ?? false;
  const runner = options.tx ?? (await import('@/db/client')).db;

  const vendorRows = (await runner.execute(sqlTag`
    select id, name, display_name, vendor_type::text as vendor_type,
           default_expense_account_id, active
      from vendors
     where (${includeInactive}::boolean or active)
     order by name`)) as unknown as VendorRow[];

  const aliasRows = (await runner.execute(sqlTag`
    select va.id, va.vendor_id, va.alias, va.alias_normalized, va.source
      from vendor_aliases va
      join vendors v on v.id = va.vendor_id
     where (${includeInactive}::boolean or v.active)
     order by va.alias`)) as unknown as AliasRow[];

  return buildVendorIndex(
    vendorRows.map((row) => ({
      id: row.id,
      name: row.name,
      displayName: row.display_name,
      vendorType: row.vendor_type,
      defaultExpenseAccountId: row.default_expense_account_id,
      active: row.active,
    })),
    aliasRows.map((row) => ({
      id: row.id,
      vendorId: row.vendor_id,
      alias: row.alias,
      aliasNormalized: row.alias_normalized ?? normalizeDescription(row.alias),
      source: row.source,
    })),
  );
}

export interface LearnAliasOptions {
  /** Actor for the audit trail. */
  readonly userId: string | null;
  /** Join the caller's transaction instead of opening one. */
  readonly tx?: Tx;
}

/**
 * Records a confirmed payee → vendor mapping so the same spelling resolves at
 * tier 1, instantly and at full confidence, on every later import.
 *
 * The alias is stored as the bank wrote it. `alias_normalized` is a generated
 * column, so the matching key is computed by the database from that raw spelling —
 * there is no second normalisation for the two to drift apart on.
 *
 * Re-learning an alias that already exists is a no-op that returns the stored row,
 * including one that was entered by hand: a confirmation should not overwrite a
 * `manual` provenance with `learned`.
 */
export async function learnAlias(
  vendorId: string,
  rawPayee: string,
  options: LearnAliasOptions,
): Promise<VendorAliasRecord> {
  const alias = rawPayee.trim();
  if (alias === '') throw new Error('Cannot learn an empty payee as a vendor alias');
  if (normalizeDescription(alias) === '') {
    throw new Error(`Payee ${JSON.stringify(rawPayee)} normalises to nothing; it cannot be an alias`);
  }

  const run = async (client: Tx): Promise<VendorAliasRecord> => {
    const inserted = await client.execute(sqlTag`
      insert into vendor_aliases (vendor_id, alias, source)
      values (${vendorId}::uuid, ${alias}, 'learned')
      on conflict (vendor_id, alias) do nothing
      returning id, vendor_id, alias, alias_normalized, source`);
    const rows = inserted as unknown as AliasRow[];
    if (rows.length > 0) return toAliasRecord(rows[0]);

    const existing = await client.execute(sqlTag`
      select id, vendor_id, alias, alias_normalized, source
        from vendor_aliases
       where vendor_id = ${vendorId}::uuid and alias = ${alias}`);
    const existingRows = existing as unknown as AliasRow[];
    if (existingRows.length === 0) {
      throw new Error(`Could not store alias ${JSON.stringify(alias)} for vendor ${vendorId}`);
    }
    return toAliasRecord(existingRows[0]);
  };

  if (options.tx !== undefined) return run(options.tx);
  const { withActor } = await import('@/db/client');
  return withActor(options.userId, run);
}

function toAliasRecord(row: AliasRow): VendorAliasRecord {
  return {
    id: row.id,
    vendorId: row.vendor_id,
    alias: row.alias,
    aliasNormalized: row.alias_normalized ?? normalizeDescription(row.alias),
    source: row.source,
  };
}
