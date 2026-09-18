import { afterAll, describe, expect, it } from 'vitest';

import { parityClient, readRelay, RELAY_PROFILE, relayFilenames } from './__fixtures__/support';
import { applyProfile } from './apply-profile';
import { cleanPayee, normalizeDescription } from './normalize';

describe('normalizeDescription', () => {
  it('upper-cases, replaces every non-alphanumeric with a space, collapses and trims', () => {
    expect(normalizeDescription('SP+AFF * META STORE -')).toBe('SP AFF META STORE');
    expect(normalizeDescription("Kalustyan's")).toBe('KALUSTYAN S');
    expect(normalizeDescription('  leading and   trailing  ')).toBe('LEADING AND TRAILING');
    expect(normalizeDescription('eBay O*22-14335-69339')).toBe('EBAY O 22 14335 69339');
    expect(normalizeDescription('PAK-MAN PACKAGING AND S')).toBe('PAK MAN PACKAGING AND S');
  });

  it('keeps digits glued to letters, because the Postgres function does', () => {
    expect(normalizeDescription('FEDEX533300619')).toBe('FEDEX533300619');
  });

  it('treats null, undefined and an all-punctuation string as the empty string', () => {
    expect(normalizeDescription(null)).toBe('');
    expect(normalizeDescription(undefined)).toBe('');
    expect(normalizeDescription('')).toBe('');
    expect(normalizeDescription('!!!')).toBe('');
    expect(normalizeDescription('①②③')).toBe('');
  });

  it('matches Postgres on the Unicode cases where a naive implementation drifts', () => {
    // These are the exact strings the live `normalize_description` was probed
    // with; each one is a place where an ASCII-only uppercase, or NFKC, or a
    // locale-sensitive `upper`, would produce something different.
    expect(normalizeDescription('Straße')).toBe('STRASSE'); // ß expands to SS
    expect(normalizeDescription('ﬁnance')).toBe('FINANCE'); // ligature expands
    expect(normalizeDescription('ﬀ')).toBe('FF');
    expect(normalizeDescription('dotless ı')).toBe('DOTLESS I'); // U+0131 upper-cases to ASCII I
    expect(normalizeDescription('İstanbul')).toBe('STANBUL'); // U+0130 stays non-ASCII
    expect(normalizeDescription('ǅungla')).toBe('UNGLA'); // titlecase digraph
    expect(normalizeDescription('café')).toBe('CAF');
    expect(normalizeDescription('ÉCLAIR')).toBe('CLAIR');
  });

  it('collapses tabs and newlines like Postgres\' \\s+ does', () => {
    expect(normalizeDescription('tab\tand\nnewline')).toBe('TAB AND NEWLINE');
  });
});

describe('normalizeDescription matches the Postgres function it has to agree with', () => {
  const sql = parityClient();
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it('round-trips every distinct payee and reference in the real Relay statements', async () => {
    // The whole point of this test: `bank_transactions.description_normalized`,
    // `vendor_aliases.alias_normalized` and `bank_txn_fingerprint()` are all
    // computed by Postgres. If this module drifts by one character, every rule
    // and every deduplication key silently stops matching.
    const subjects = new Set<string>();
    for (const filename of relayFilenames()) {
      const file = await readRelay(filename);
      const parsed = applyProfile(file, RELAY_PROFILE);
      for (const row of parsed.rows) {
        subjects.add(row.description);
        if (row.reference !== null) subjects.add(row.reference);
        if (row.counterparty !== null) subjects.add(row.counterparty);
      }
    }

    // Plus the Unicode edge cases, which real payees do not happen to contain.
    for (const extra of ['Straße', 'ﬁnance', 'dotless ı', 'İstanbul', 'ǅungla', 'café', '①②③', '', '!!!']) {
      subjects.add(extra);
    }

    const cases = [...subjects];
    expect(cases.length).toBeGreaterThan(50);

    // Bound as a parameter, not interpolated: the payees contain commas, quotes
    // and braces, every one of which is array-literal syntax.
    const rows = await sql<Array<{ input: string; expected: string }>>`
      select value as input, normalize_description(value) as expected
      from unnest(${cases}::text[]) as value
    `;

    expect(rows.length).toBe(cases.length);
    const drift = rows
      .filter((row) => normalizeDescription(row.input) !== row.expected)
      .map((row) => ({ input: row.input, postgres: row.expected, typescript: normalizeDescription(row.input) }));
    expect(drift).toEqual([]);
  });
});

describe('cleanPayee', () => {
  it('strips processor prefixes and reports which one', () => {
    expect(cleanPayee('SP+AFF * META STORE -')).toMatchObject({ name: 'META STORE', processor: 'SP+AFF' });
    expect(cleanPayee('SP NATURES FLAVORS')).toMatchObject({ name: 'NATURES FLAVORS', processor: 'SP' });
    expect(cleanPayee('SP PURIVA NUTRITION')).toMatchObject({ name: 'PURIVA NUTRITION', processor: 'SP' });
    expect(cleanPayee('TST* LOCAL DINER')).toMatchObject({ name: 'LOCAL DINER', processor: 'TST' });
    expect(cleanPayee('SQ *COFFEE BAR')).toMatchObject({ name: 'COFFEE BAR', processor: 'SQ' });
  });

  it('strips trailing reference digits, glued or separated', () => {
    expect(cleanPayee('FEDEX533300619')).toMatchObject({ name: 'FEDEX', trailingDigits: '533300619' });
    expect(cleanPayee('eBay O*22-14335-69339')).toMatchObject({ name: 'eBay', trailingDigits: 'O*22-14335-69339' });
    expect(cleanPayee('FEDEX 533300619')).toMatchObject({ name: 'FEDEX', trailingDigits: '533300619' });
  });

  it("strips Relay's Sent By / Initiated By suffixes and keeps the names", () => {
    expect(cleanPayee('Blue Pacific Flavors - Sent By Boxuan Zhao')).toMatchObject({
      name: 'Blue Pacific Flavors',
      sentBy: 'Boxuan Zhao',
      initiatedBy: null,
    });
    expect(cleanPayee('GOOGLE - Initiated By Unknown Payee')).toMatchObject({
      name: 'GOOGLE',
      initiatedBy: 'Unknown Payee',
      sentBy: null,
    });
  });

  it('leaves clean payees exactly as the bank wrote them', () => {
    for (const payee of [
      'Blue Pacific Flavors',
      'Jedwards International Inc.',
      'Adv SafeBalance Banking',
      'CHASE COLLEGE',
      'DAVESHOTCHICKEN',
      "Kalustyan's",
      'PAK-MAN PACKAGING AND S',
      'Andrew Firestone',
      'Square Inc',
      'Amazon',
      'Relay',
      'Box Nutra',
      'INGREDI COMPANY LLC',
      'LAB ALLEY LLC',
      "Owner's Comp",
    ]) {
      expect(cleanPayee(payee).name).toBe(payee);
    }
  });

  it('records everything it removed, so the audit trail keeps the bank\'s own words', () => {
    const cleaned = cleanPayee('SP+AFF * META STORE 4471 - Sent By Boxuan Zhao');
    expect(cleaned.name).toBe('META STORE');
    expect(cleaned.original).toBe('SP+AFF * META STORE 4471 - Sent By Boxuan Zhao');
    expect(cleaned.sentBy).toBe('Boxuan Zhao');
    expect(cleaned.processor).toBe('SP+AFF');
    expect(cleaned.trailingDigits).toBe('4471');
    expect(cleaned.stripped).toContain('- Sent By Boxuan Zhao');
  });

  it('never returns an empty name for a non-empty payee', () => {
    const cleaned = cleanPayee('9726');
    expect(cleaned.name).toBe('9726');
    expect(cleanPayee('SP ').name).toBe('SP');
  });

  it('handles an absent payee', () => {
    expect(cleanPayee(null)).toMatchObject({ name: '', original: '', processor: null });
    expect(cleanPayee('  ')).toMatchObject({ name: '', original: '' });
  });

  it('collapses the several spellings of one merchant onto one normalized form', () => {
    // This is what makes vendor matching work: `GOOGLE` and `Google`, `Meta Store`
    // and `SP+AFF * META STORE -`, `FedEx` and `FEDEX533300619` are each one vendor.
    const normalize = (payee: string): string => normalizeDescription(cleanPayee(payee).name);
    expect(normalize('GOOGLE')).toBe(normalize('Google'));
    expect(normalize('Meta Store')).toBe(normalize('SP+AFF * META STORE -'));
    expect(normalize('FedEx')).toBe(normalize('FEDEX533300619'));
  });
});
