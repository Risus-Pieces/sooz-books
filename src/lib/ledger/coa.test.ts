import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTS,
  BANK_ACCOUNT_CODES,
  CHANNELS,
  CHANNEL_CLEARING_ACCOUNT,
  CHANNEL_CODES,
  CHANNEL_REVENUE_ACCOUNT,
  COA_SEED,
  CONTRA_REVENUE_CODES,
  accountByCode,
  childrenOf,
  isPostable,
  isRollup,
  requireAccount,
  type AccountSeed,
} from './coa';

const CODES = new Set(COA_SEED.map((a) => a.code));

describe('chart of accounts definition', () => {
  it('has unique account codes', () => {
    expect(CODES.size).toBe(COA_SEED.length);
  });

  it('maps every semantic name to a seeded account', () => {
    for (const [key, code] of Object.entries(ACCOUNTS)) {
      expect(CODES.has(code), `ACCOUNTS.${key} = ${code} is not in COA_SEED`).toBe(true);
    }
  });

  it('gives every seeded account a semantic name', () => {
    const named = new Set<string>(Object.values(ACCOUNTS));
    expect(named.size).toBe(Object.keys(ACCOUNTS).length);
    for (const account of COA_SEED) {
      expect(named.has(account.code), `${account.code} ${account.name} has no ACCOUNTS key`).toBe(
        true,
      );
    }
  });

  it('resolves every parent code', () => {
    for (const account of COA_SEED) {
      if (account.parentCode === null) continue;
      expect(
        CODES.has(account.parentCode),
        `${account.code} points at missing parent ${account.parentCode}`,
      ).toBe(true);
    }
  });

  it('has no cycle in the parent chain', () => {
    for (const account of COA_SEED) {
      const seen = new Set<string>([account.code]);
      let cursor = account.parentCode;
      while (cursor !== null) {
        expect(seen.has(cursor), `${account.code} has a cycle through ${cursor}`).toBe(false);
        seen.add(cursor);
        cursor = requireAccount(cursor).parentCode;
      }
    }
  });

  it('keeps a rollup the same type as its children', () => {
    for (const account of COA_SEED) {
      for (const child of childrenOf(account.code)) {
        expect(child.type, `${child.code} under ${account.code}`).toBe(account.type);
      }
    }
  });

  it('gives every account a description', () => {
    for (const account of COA_SEED) {
      expect(account.description.trim().length, `${account.code} has no description`).toBeGreaterThan(
        10,
      );
    }
  });

  it('types every contra-revenue account as revenue so it nets into net sales', () => {
    expect(CONTRA_REVENUE_CODES.length).toBeGreaterThanOrEqual(11);
    for (const code of CONTRA_REVENUE_CODES) {
      const account = requireAccount(code);
      expect(account.type, `${code} ${account.name}`).toBe('revenue');
      expect(account.subtype).toBe('contra_revenue');
    }
    // The blocks a CPG chart is judged on.
    for (const key of [
      'TRADE_OFF_INVOICE',
      'TRADE_BILLBACK',
      'TRADE_SCAN_DOWN',
      'TRADE_SLOTTING',
      'TRADE_SPOILAGE_ALLOWANCE',
      'DISTRIBUTOR_FEES',
      'MARKETPLACE_FEES',
      'EARLY_PAYMENT_DISCOUNTS',
      'RETURNS_AND_ALLOWANCES',
      'UNAUTHORIZED_DEDUCTIONS',
      'COUPONS_AND_PROMOS',
    ] as const) {
      expect(CONTRA_REVENUE_CODES).toContain(ACCOUNTS[key]);
    }
  });

  it('marks AR and AP as the only control accounts', () => {
    const control = COA_SEED.filter((a) => a.isControl).map((a) => a.code);
    expect(control.sort()).toEqual([ACCOUNTS.AR, ACCOUNTS.AP].sort());
    expect(requireAccount(ACCOUNTS.AR).type).toBe('asset');
    expect(requireAccount(ACCOUNTS.AP).type).toBe('liability');
  });

  it('flags only statement-backed accounts as bank accounts', () => {
    expect(BANK_ACCOUNT_CODES.length).toBeGreaterThan(0);
    for (const code of BANK_ACCOUNT_CODES) {
      const account = requireAccount(code);
      expect(['bank', 'credit_card'], `${code} ${account.name}`).toContain(account.subtype);
    }
  });

  it('attaches each clearing account to at most one channel', () => {
    const used = new Map<string, string>();
    for (const account of COA_SEED) {
      if (account.clearingForChannel === null) continue;
      expect(account.subtype).toBe('clearing');
      // Square is DTC's second processor: its clearing account sits beside Shopify's.
      if (account.code === ACCOUNTS.CLEARING_SQUARE) {
        expect(account.clearingForChannel).toBe('DTC');
        continue;
      }
      expect(CHANNEL_CODES).toContain(account.clearingForChannel);
      expect(used.has(account.clearingForChannel)).toBe(false);
      used.set(account.clearingForChannel, account.code);
    }
    expect(used.get('DTC')).toBe(ACCOUNTS.CLEARING_SHOPIFY);
    expect(used.get('AMAZON')).toBe(ACCOUNTS.CLEARING_AMAZON);
    expect(used.get('WHOLESALE')).toBe(ACCOUNTS.CLEARING_FAIRE);
    // The generic processor clearing account belongs to no single channel.
    expect(requireAccount(ACCOUNTS.CLEARING_PROCESSOR).clearingForChannel).toBeNull();
  });

  it('resolves the per-channel revenue and clearing lookups', () => {
    for (const channel of CHANNEL_CODES) {
      const revenue = requireAccount(CHANNEL_REVENUE_ACCOUNT[channel]);
      expect(revenue.type).toBe('revenue');
      expect(revenue.subtype).toBe('sales');

      const clearing = CHANNEL_CLEARING_ACCOUNT[channel];
      if (clearing !== null) {
        expect(requireAccount(clearing).subtype).toBe('clearing');
      }
    }
    expect(CHANNELS.map((c) => c.code).sort()).toEqual([...CHANNEL_CODES].sort());
  });

  it('keeps fulfillment costs out of the COGS rollup', () => {
    const cogs = childrenOf(ACCOUNTS.COGS).map((a) => a.code);
    expect(cogs).toContain(ACCOUNTS.COGS_FREIGHT_IN);
    expect(cogs).not.toContain(ACCOUNTS.OUTBOUND_FREIGHT);
    for (const account of childrenOf(ACCOUNTS.FULFILLMENT)) {
      expect(account.subtype).toBe('fulfillment');
    }
  });

  it('distinguishes rollups from postable accounts', () => {
    expect(isRollup(ACCOUNTS.INVENTORY)).toBe(true);
    expect(isPostable(ACCOUNTS.INVENTORY)).toBe(false);
    expect(isPostable(ACCOUNTS.INVENTORY_FINISHED)).toBe(true);
    expect(isPostable('nope')).toBe(false);
    expect(accountByCode('nope')).toBeUndefined();
    expect(() => requireAccount('nope')).toThrow(/Unknown account code/);
  });
});

// ---------------------------------------------------------------------------
// The seeded chart must match what is actually in the database.
// ---------------------------------------------------------------------------

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

interface AccountRow {
  code: string;
  name: string;
  type: string;
  subtype: string | null;
  parent_code: string | null;
  is_bank: boolean;
  is_control: boolean;
  channel_code: string | null;
  description: string | null;
}

function comparable(account: AccountSeed) {
  return {
    code: account.code,
    name: account.name,
    type: account.type,
    subtype: account.subtype as string | null,
    parent_code: account.parentCode,
    is_bank: account.isBank,
    is_control: account.isControl,
    channel_code: account.clearingForChannel as string | null,
    description: account.description as string | null,
  };
}

const DATABASE_URL = databaseUrl();

describe.skipIf(!DATABASE_URL)('chart of accounts in the database', () => {
  const sql = postgres(DATABASE_URL ?? '', { max: 1, prepare: false, onnotice: () => {} });

  afterAll(async () => {
    await sql.end();
  });

  it('seeds the five channels', async () => {
    const rows = await sql<{ code: string; name: string }[]>`
      select code, name from channels order by sort_order`;
    expect(rows.map((r) => r.code)).toEqual(CHANNELS.map((c) => c.code));
    expect(rows.map((r) => r.name)).toEqual(CHANNELS.map((c) => c.name));
  }, 20_000);

  it('holds every seeded account, field for field', async () => {
    const rows = await sql<AccountRow[]>`
      select a.code,
             a.name,
             a.type::text as type,
             a.subtype,
             p.code  as parent_code,
             a.is_bank,
             a.is_control,
             ch.code as channel_code,
             a.description
        from accounts a
        left join accounts p  on p.id  = a.parent_id
        left join channels ch on ch.id = a.clearing_for_channel_id
       where a.code = any(${COA_SEED.map((a) => a.code)})
       order by a.code`;

    const actual = rows.map((r) => ({ ...r }));
    const expected = [...COA_SEED]
      .map(comparable)
      .sort((a, b) => a.code.localeCompare(b.code));

    expect(actual.map((r) => r.code)).toEqual(expected.map((r) => r.code));
    expect(actual).toEqual(expected);
  }, 20_000);
});
