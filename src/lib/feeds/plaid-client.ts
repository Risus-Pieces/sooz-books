/**
 * The handful of Plaid endpoints the bank feed uses, over plain `fetch`.
 *
 * Five calls do not justify an SDK, and a `fetch` can be swapped for a fake in tests. Amounts are read
 * from the raw JSON text, not from the parsed number, so no floating-point value ever reaches the money
 * path: `JSON.parse` hands a reviver the source text of each number.
 */

export type PlaidEnvironment = 'sandbox' | 'production';

export interface PlaidConfig {
  clientId: string;
  secret: string;
  env: PlaidEnvironment;
}

/** The configuration, or null when the feed is not set up. */
export function plaidConfig(env: Readonly<Record<string, string | undefined>> = process.env): PlaidConfig | null {
  const clientId = env.PLAID_CLIENT_ID;
  const secret = env.PLAID_SECRET;
  if (!clientId || !secret) return null;
  return { clientId, secret, env: env.PLAID_ENV === 'production' ? 'production' : 'sandbox' };
}

export class PlaidError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PlaidError';
    this.code = code;
  }
}

export interface PlaidAccountInfo {
  account_id: string;
  name: string;
  official_name: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
}

export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  /** Decimal string as Plaid sent it. Positive is money OUT of the account. */
  amount: string;
  iso_currency_code: string | null;
  date: string;
  name: string;
  merchant_name: string | null;
  original_description?: string | null;
  pending: boolean;
}

export interface TransactionsSyncPage {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: { transaction_id: string; account_id?: string }[];
  next_cursor: string;
  has_more: boolean;
}

export interface PlaidClient {
  createLinkToken(clientUserId: string): Promise<string>;
  exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }>;
  getAccounts(accessToken: string): Promise<{ accounts: PlaidAccountInfo[]; institutionName: string | null }>;
  syncTransactions(accessToken: string, cursor: string | null): Promise<TransactionsSyncPage>;
  removeItem(accessToken: string): Promise<void>;
}

/** Keeps every `amount` as the exact text Plaid sent. */
function parseKeepingAmounts(text: string): unknown {
  return JSON.parse(text, function reviver(this: unknown, key: string, value: unknown, context?: { source?: string }) {
    if (key === 'amount' && typeof value === 'number') return context?.source ?? String(value);
    return value;
  } as (key: string, value: unknown) => unknown);
}

export function createPlaidClient(config: PlaidConfig, fetchImpl: typeof fetch = fetch): PlaidClient {
  const base = config.env === 'production' ? 'https://production.plaid.com' : 'https://sandbox.plaid.com';

  async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetchImpl(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: config.clientId, secret: config.secret, ...body }),
    });
    const text = await response.text();
    let data: unknown;
    try {
      data = parseKeepingAmounts(text);
    } catch {
      throw new PlaidError('bad_response', `Plaid answered ${response.status} with something that is not JSON.`);
    }
    if (!response.ok) {
      const error = data as { error_code?: string; error_message?: string; display_message?: string | null };
      throw new PlaidError(error.error_code ?? `http_${response.status}`, error.display_message ?? error.error_message ?? `Plaid answered ${response.status}.`);
    }
    return data as T;
  }

  return {
    async createLinkToken(clientUserId) {
      const data = await call<{ link_token: string }>('/link/token/create', {
        client_name: 'Sooz Books',
        user: { client_user_id: clientUserId },
        products: ['transactions'],
        country_codes: ['US'],
        language: 'en',
      });
      return data.link_token;
    },
    async exchangePublicToken(publicToken) {
      const data = await call<{ access_token: string; item_id: string }>('/item/public_token/exchange', { public_token: publicToken });
      return { accessToken: data.access_token, itemId: data.item_id };
    },
    async getAccounts(accessToken) {
      const data = await call<{ accounts: PlaidAccountInfo[]; item?: { institution_name?: string | null } }>('/accounts/get', { access_token: accessToken });
      return { accounts: data.accounts, institutionName: data.item?.institution_name ?? null };
    },
    async syncTransactions(accessToken, cursor) {
      return call<TransactionsSyncPage>('/transactions/sync', {
        access_token: accessToken,
        ...(cursor === null ? {} : { cursor }),
        count: 500,
        // The bank's own wording, which the rules and the CSV history were written against.
        options: { include_original_description: true },
      });
    },
    async removeItem(accessToken) {
      await call('/item/remove', { access_token: accessToken });
    },
  };
}
