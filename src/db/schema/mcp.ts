import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { appUsers } from './ledger';

export const STAGE_KINDS = ['bank_decisions', 'journal_entry', 'new_account'] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

/**
 * A change Claude has proposed through the MCP connector and a person has not yet confirmed.
 *
 * Mirrors `supabase/migrations/0048_mcp_stagings.sql`. Nothing here is a ledger entry.
 */
export const mcpStagings = pgTable('mcp_stagings', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => appUsers.id),
  clientId: text('client_id'),
  kind: text('kind').$type<StageKind>().notNull(),
  payload: jsonb('payload').$type<unknown>().notNull(),
  preview: jsonb('preview').$type<unknown>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  committedAt: timestamp('committed_at', { withTimezone: true }),
  result: jsonb('result').$type<unknown>(),
});

export type McpStaging = typeof mcpStagings.$inferSelect;
