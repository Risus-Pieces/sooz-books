import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { sql as sqlTag } from 'drizzle-orm';
import Papa from 'papaparse';
import { afterAll, describe, expect, it } from 'vitest';

import { normalizeDescription } from './normalize';
import {
  buildVendorIndex,
  jaro,
  jaroWinkler,
  learnAlias,
  levenshtein,
  loadVendorIndex,
  resolveVendor,
  vendorMatchKey,
  type VendorAliasRecord,
  type VendorRecord,
} from './vendors';

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

describe('vendorMatchKey', () => {
  const cases: ReadonlyArray<[string, string]> = [
    ['SP+AFF * META STORE -', 'META STORE'],
    ['SP NATURES FLAVORS', 'NATURES FLAVORS'],
    ['SP BUILDASOIL', 'BUILDASOIL'],
    ['FEDEX533300619', 'FEDEX'],
    ['eBay O*22-14335-69339', 'EBAY'],
    ['LAB ALLEY LLC', 'LAB ALLEY'],
    ['INGREDI COMPANY LLC', 'INGREDI'],
    ['Jedwards International Inc.', 'JEDWARDS INTERNATIONAL'],
    ['Online Labels LLC', 'ONLINE LABELS'],
    ['PAK-MAN PACKAGING AND S', 'PAK MAN PACKAGING'],
    ['Square Inc', 'SQUARE'],
    ["Kalustyan's", 'KALUSTYAN'],
    ['Pak-Man Packaging', 'PAK MAN PACKAGING'],
    ['Amazon', 'AMAZON'],
    ['CHASE COLLEGE', 'CHASE COLLEGE'],
    ['', ''],
  ];

  it.each(cases)('reduces %j to %j', (raw, expected) => {
    expect(vendorMatchKey(raw)).toBe(expected);
  });

  it('meets a dirty payee and a clean vendor name in the middle', () => {
    expect(vendorMatchKey('PAK-MAN PACKAGING AND S')).toBe(vendorMatchKey('Pak-Man Packaging'));
    expect(vendorMatchKey('FEDEX533300619')).toBe(vendorMatchKey('FedEx'));
    expect(vendorMatchKey('SP+AFF * META STORE -')).toBe(vendorMatchKey('Meta Store'));
  });

  it('keeps a leading number that is part of the name', () => {
    expect(vendorMatchKey('7 Eleven')).toBe('7 ELEVEN');
  });

  it('never reduces a payee to nothing', () => {
    expect(vendorMatchKey('SP')).toBe('SP');
    expect(vendorMatchKey('LLC')).toBe('LLC');
  });
});

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

describe('string similarity', () => {
  it('computes the published Jaro / Jaro-Winkler values', () => {
    expect(jaro('MARTHA', 'MARHTA')).toBeCloseTo(0.944, 3);
    expect(jaroWinkler('MARTHA', 'MARHTA')).toBeCloseTo(0.961, 3);
    expect(jaro('DWAYNE', 'DUANE')).toBeCloseTo(0.822, 3);
    expect(jaroWinkler('DWAYNE', 'DUANE')).toBeCloseTo(0.84, 2);
    expect(jaro('DIXON', 'DICKSONX')).toBeCloseTo(0.767, 3);
    expect(jaroWinkler('DIXON', 'DICKSONX')).toBeCloseTo(0.813, 3);
  });

  it('is 1 for identical strings and 0 for nothing in common', () => {
    expect(jaroWinkler('AMAZON', 'AMAZON')).toBe(1);
    expect(jaroWinkler('', '')).toBe(1);
    expect(jaroWinkler('AMAZON', '')).toBe(0);
    expect(jaroWinkler('AAAA', 'BBBB')).toBe(0);
  });

  it('rewards a shared prefix, which is where merchant names agree', () => {
    expect(jaroWinkler('BULK SUPPLEMENT', 'BULK SUPPLEMENTS')).toBeGreaterThan(0.98);
    expect(jaroWinkler('BULK SUPPLEMENT', 'PAK MAN PACKAGING')).toBeLessThan(0.6);
  });

  it('measures edit distance', () => {
    expect(levenshtein('FEDEX', 'FEDEX')).toBe(0);
    expect(levenshtein('FEDEX', 'FEDX')).toBe(1);
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Resolution tiers, on a hand-built index
// ---------------------------------------------------------------------------

const VENDORS: readonly VendorRecord[] = [
  {
    id: 'v-fedex',
    name: 'FedEx',
    displayName: null,
    vendorType: 'freight',
    defaultExpenseAccountId: 'a-5510',
    active: true,
  },
  {
    id: 'v-jedwards',
    name: 'Jedwards International',
    displayName: null,
    vendorType: 'ingredients',
    defaultExpenseAccountId: 'a-1320',
    active: true,
  },
  {
    id: 'v-amazon',
    name: 'Amazon',
    displayName: null,
    vendorType: 'other',
    defaultExpenseAccountId: null,
    active: true,
  },
];

const ALIASES: readonly VendorAliasRecord[] = [
  {
    id: 'al-1',
    vendorId: 'v-fedex',
    alias: 'FEDEX533300619',
    aliasNormalized: 'FEDEX533300619',
    source: 'manual',
  },
  {
    id: 'al-2',
    vendorId: 'v-amazon',
    alias: 'Amazon',
    aliasNormalized: 'AMAZON',
    source: 'manual',
  },
];

const INDEX = buildVendorIndex(VENDORS, ALIASES);

describe('resolveVendor', () => {
  it('matches a stored alias verbatim at full confidence', () => {
    const match = resolveVendor('FEDEX533300619', INDEX);
    expect(match?.vendorId).toBe('v-fedex');
    expect(match?.method).toBe('alias_exact');
    expect(match?.confidence).toBe(1);
    expect(match?.defaultExpenseAccountId).toBe('a-5510');
  });

  it('matches on the cleaned payee when the raw spelling is unknown', () => {
    const match = resolveVendor('Jedwards International Inc.', INDEX);
    expect(match?.vendorId).toBe('v-jedwards');
    expect(match?.method).toBe('vendor_name');
    expect(match?.confidence).toBe(0.92);
  });

  it('falls back to fuzzy, below the deterministic tiers', () => {
    const match = resolveVendor('FEDDEX', INDEX);
    expect(match?.vendorId).toBe('v-fedex');
    expect(match?.method).toBe('fuzzy');
    expect(match?.confidence).toBeLessThanOrEqual(0.9);
  });

  it('returns null rather than guessing', () => {
    expect(resolveVendor('CHASE COLLEGE', INDEX)).toBeNull();
    expect(resolveVendor('Adv SafeBalance Banking', INDEX)).toBeNull();
    expect(resolveVendor("Owner's Comp", INDEX)).toBeNull();
    expect(resolveVendor('', INDEX)).toBeNull();
    expect(resolveVendor(null, INDEX)).toBeNull();
  });

  it('does not fuzzy-match a payee too short to be evidence', () => {
    expect(resolveVendor('FED', INDEX)).toBeNull();
  });

  it('refuses to choose between two vendors that are equally close', () => {
    const twins = buildVendorIndex(
      [
        { ...VENDORS[0], id: 'v-a', name: 'Northwind Tradera' },
        { ...VENDORS[0], id: 'v-b', name: 'Northwind Traderb' },
      ],
      [],
    );
    // Equidistant from both: one substitution in the last character either way.
    expect(resolveVendor('Northwind Traderc', twins)).toBeNull();
  });

  it('refuses an alias two different vendors both claim', () => {
    const conflicted = buildVendorIndex(VENDORS, [
      ...ALIASES,
      { id: 'al-3', vendorId: 'v-jedwards', alias: 'Amazon', aliasNormalized: 'AMAZON', source: 'manual' },
    ]);
    const match = resolveVendor('Amazon', conflicted);
    expect(match?.method).not.toBe('alias_exact');
  });
});

// ---------------------------------------------------------------------------
// The real Relay payees against the seeded vendors
// ---------------------------------------------------------------------------

const RELAY_DIR = fileURLToPath(new URL('../../../data/statements/relay', import.meta.url));

interface RelayRow {
  readonly Date: string;
  readonly Payee: string;
}

/** Every distinct `Payee` string across the 36 real statement exports. */
function distinctRelayPayees(): string[] {
  if (!existsSync(RELAY_DIR)) return [];
  const seen = new Set<string>();
  for (const file of readdirSync(RELAY_DIR).filter((f) => f.endsWith('.csv')).sort()) {
    const parsed = Papa.parse<RelayRow>(readFileSync(`${RELAY_DIR}/${file}`, 'utf8'), {
      header: true,
      skipEmptyLines: true,
    });
    for (const row of parsed.data) {
      if (!row.Date) continue;
      seen.add(row.Payee ?? '');
    }
  }
  return [...seen].sort();
}

function databaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = fileURLToPath(new URL('../../../.env.local', import.meta.url));
  if (!existsSync(envPath)) return undefined;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^\s*DATABASE_URL\s*=\s*(.*)$/.exec(line);
    if (match) return match[1].trim().replace(/^["']|["']$/g, '');
  }
  return undefined;
}

const DATABASE_URL = databaseUrl();
if (DATABASE_URL !== undefined) process.env.DATABASE_URL = DATABASE_URL;

const PAYEES = distinctRelayPayees();

/**
 * The five payees that are genuinely not vendors: two personal bank accounts the
 * owner funds the company from, two Relay sub-account names that appear on internal
 * transfers, and one transfer row Relay exported with no payee at all.
 */
const NOT_VENDORS = [
  '',
  'Adv SafeBalance Banking',
  'CHASE COLLEGE',
  'Operating Expenses',
  "Owner's Comp",
];

describe('real Relay payees', () => {
  it('has the statement fixtures on disk', () => {
    expect(existsSync(RELAY_DIR), `real Relay statements are missing from ${RELAY_DIR}`).toBe(true);
  });

  it('holds 42 distinct payee spellings', () => {
    expect(PAYEES).toHaveLength(42);
  });
});

describe.skipIf(!DATABASE_URL || PAYEES.length === 0)('resolution against the seeded vendors', () => {
  afterAll(async () => {
    const cache = globalThis as typeof globalThis & {
      __soozBooksSql?: { end: () => Promise<void> };
      __soozBooksDb?: unknown;
    };
    const pool = cache.__soozBooksSql;
    delete cache.__soozBooksSql;
    delete cache.__soozBooksDb;
    if (pool !== undefined) await pool.end();
  });

  it('normalises exactly the way the database does', async () => {
    const { sql } = await import('@/db/client');
    const rows = await sql<Array<{ raw: string; normalized: string }>>`
      select raw, normalize_description(raw) as normalized
        from unnest(${PAYEES}::text[]) as raw`;
    expect(rows).toHaveLength(PAYEES.length);
    for (const row of rows) {
      expect(normalizeDescription(row.raw), `normalising ${JSON.stringify(row.raw)}`).toBe(
        row.normalized,
      );
    }
  }, 30_000);

  it('resolves every distinct payee to a vendor or to a deliberate no-match', async () => {
    const index = await loadVendorIndex();
    expect(index.vendors.size).toBeGreaterThanOrEqual(32);

    const unresolved: string[] = [];
    const resolved = new Map<string, string>();
    for (const payee of PAYEES) {
      const match = resolveVendor(payee, index);
      if (match === null) unresolved.push(payee);
      else resolved.set(payee, `${match.vendorName} (${match.method} ${match.confidence})`);
    }

    // The message lists the offenders, so a regression says which payee broke.
    expect(unresolved, `unresolved payees: ${JSON.stringify(unresolved)}`).toEqual(NOT_VENDORS);
    expect(resolved.size).toBe(PAYEES.length - NOT_VENDORS.length);
    expect(resolved.size).toBe(37);
  }, 30_000);

  it('resolves the dirty spellings to the right vendor, not just to some vendor', async () => {
    const index = await loadVendorIndex();
    const expected: ReadonlyArray<[string, string]> = [
      ['SP+AFF * META STORE -', 'Meta'],
      ['Meta Store', 'Meta'],
      ['FEDEX533300619', 'FedEx'],
      ['FedEx', 'FedEx'],
      ['GOOGLE', 'Google'],
      ['Google', 'Google'],
      ['eBay O*22-14335-69339', 'eBay'],
      ['SP NATURES FLAVORS', "Nature's Flavors"],
      ['PAK-MAN PACKAGING AND S', 'Pak-Man Packaging'],
      ['INGREDI COMPANY LLC', 'Ingredi'],
      ['LAB ALLEY LLC', 'Lab Alley'],
      ['Jedwards International Inc.', 'Jedwards International'],
      ['FIRESTONE CONSUL', 'Andrew Firestone'],
      ['Andrew Firestone', 'Andrew Firestone'],
      ['Rice Parking', 'Rice University'],
      ['RICE UNIVERSITY', 'Rice University'],
      ['Square Inc', 'Square'],
      ['Grok', 'xAI (Grok)'],
      ['AMCO', 'AMCO Proteins'],
      ['Amazon', 'Amazon'],
    ];
    for (const [payee, vendorName] of expected) {
      expect(resolveVendor(payee, index)?.vendorName, `payee ${JSON.stringify(payee)}`).toBe(
        vendorName,
      );
    }
  }, 30_000);

  it('never invents a vendor for the owner-funding and internal-transfer payees', async () => {
    const index = await loadVendorIndex();
    for (const payee of NOT_VENDORS) {
      expect(resolveVendor(payee, index), `payee ${JSON.stringify(payee)}`).toBeNull();
    }
  }, 30_000);

  it('learns a confirmed spelling so it resolves at tier one next time', async () => {
    const index = await loadVendorIndex();
    const amazon = [...index.vendors.values()].find((v) => v.name === 'Amazon');
    expect(amazon).toBeDefined();
    const vendorId = amazon?.id ?? '';
    const spelling = 'AMZN Mktp US*RT4X92JK3';

    // Nothing today knows this spelling.
    expect(resolveVendor(spelling, index)).toBeNull();

    const { db } = await import('@/db/client');
    class Rollback extends Error {}
    let learnedAliasId = '';
    let learnedSource = '';
    let storedNormalized = '';
    let resolvedAfter: string | null = null;
    let secondCallAliasId = '';

    try {
      await db.transaction(async (tx) => {
        await tx.execute(sqlTag`select set_config('app.user_id', '', true)`);
        const record = await learnAlias(vendorId, spelling, { userId: null, tx });
        learnedAliasId = record.id;
        learnedSource = record.source;
        storedNormalized = record.aliasNormalized;

        // Re-learning is idempotent and returns the same row.
        const again = await learnAlias(vendorId, spelling, { userId: null, tx });
        secondCallAliasId = again.id;

        const rows = (await tx.execute(sqlTag`
          select v.id, v.name, v.display_name, v.default_expense_account_id, v.active,
                 v.vendor_type::text as vendor_type
            from vendors v where v.id = ${vendorId}::uuid`)) as unknown as Array<{
          id: string;
          name: string;
          display_name: string | null;
          default_expense_account_id: string | null;
          active: boolean;
          vendor_type: string;
        }>;
        const rebuilt = buildVendorIndex(
          rows.map((r) => ({
            id: r.id,
            name: r.name,
            displayName: r.display_name,
            vendorType: r.vendor_type,
            defaultExpenseAccountId: r.default_expense_account_id,
            active: r.active,
          })),
          [
            {
              id: record.id,
              vendorId: record.vendorId,
              alias: record.alias,
              aliasNormalized: record.aliasNormalized,
              source: record.source,
            },
          ],
        );
        resolvedAfter = resolveVendor(spelling, rebuilt)?.method ?? null;

        // Never leave a learned alias behind: the seeded set is shared state.
        throw new Rollback('done');
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }

    expect(learnedAliasId).not.toBe('');
    expect(learnedSource).toBe('learned');
    // alias_normalized is a generated column: the database computed this, not us.
    expect(storedNormalized).toBe('AMZN MKTP US RT4X92JK3');
    expect(normalizeDescription(spelling)).toBe(storedNormalized);
    expect(secondCallAliasId).toBe(learnedAliasId);
    expect(resolvedAfter).toBe('alias_exact');

    // And the rollback really did roll back.
    const { sql } = await import('@/db/client');
    const left = await sql<Array<{ count: string }>>`
      select count(*)::text as count from vendor_aliases where alias = ${spelling}`;
    expect(Number(left[0].count)).toBe(0);
  }, 30_000);

  it('refuses to learn an alias that carries no signal', async () => {
    await expect(learnAlias('00000000-0000-0000-0000-000000000000', '   ', { userId: null }))
      .rejects.toThrow(/empty payee/);
    await expect(learnAlias('00000000-0000-0000-0000-000000000000', '***', { userId: null }))
      .rejects.toThrow(/normalises to nothing/);
  });
});
