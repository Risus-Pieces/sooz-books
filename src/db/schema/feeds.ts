import { date, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { bankAccounts } from './banking';
import { appUsers } from './ledger';

/**
 * One owner's sign-in to one bank through Plaid Link. Mirrors
 * `supabase/migrations/0049_bank_feeds_and_keys.sql`. `accessTokenEnc` is AES-256-GCM ciphertext;
 * see `@/lib/feeds/crypto`.
 */
export const plaidItems = pgTable('plaid_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  itemId: text('item_id').notNull().unique(),
  institutionName: text('institution_name'),
  accessTokenEnc: text('access_token_enc').notNull(),
  cursor: text('cursor'),
  status: text('status').$type<'active' | 'disconnected'>().notNull().default('active'),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => appUsers.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
});

/** One account inside a Plaid item, and the bank account it feeds (null until mapped). */
export const plaidAccounts = pgTable('plaid_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  plaidItemId: uuid('plaid_item_id')
    .notNull()
    .references(() => plaidItems.id, { onDelete: 'cascade' }),
  plaidAccountId: text('plaid_account_id').notNull().unique(),
  bankAccountId: uuid('bank_account_id')
    .unique()
    .references(() => bankAccounts.id),
  name: text('name').notNull(),
  mask: text('mask'),
  syncFrom: date('sync_from', { mode: 'string' }),
  /** Null while the mapping is only a proposal; nothing syncs until an owner confirms it. */
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const API_KEY_SCOPES = ['read', 'bank.sync', 'bank.autopost', 'stage'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** A scoped key an unattended agent uses instead of a person's sign-in. Only the hash is stored. */
export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => appUsers.id),
  tokenHash: text('token_hash').notNull().unique(),
  prefix: text('prefix').notNull(),
  scopes: text('scopes').array().$type<ApiKeyScope[]>().notNull(),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => appUsers.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export type PlaidItem = typeof plaidItems.$inferSelect;
export type PlaidAccount = typeof plaidAccounts.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
