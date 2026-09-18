import { config as loadEnvFile } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

loadEnvFile({ path: '.env.local', quiet: true });

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is not set in .env.local; drizzle-kit cannot reach the database.');
}

/**
 * Migrations for this project are hand-written SQL in supabase/migrations,
 * applied with `psql "$DATABASE_URL" -f <file>.sql`. drizzle-kit is here for
 * introspection and typing only — `drizzle-kit pull` and `drizzle-kit studio`.
 *
 * Nothing here can overwrite the hand-written SQL: `generate` only ever appends
 * a new numbered file beside them, and `strict` makes `push` stop for
 * confirmation rather than altering the live database on its own. The filters
 * keep Supabase's own schemas and roles out of every diff so an introspection
 * never proposes dropping them.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './supabase/migrations',
  dbCredentials: { url },
  schemaFilter: ['public'],
  entities: { roles: false },
  migrations: { prefix: 'index', table: '__drizzle_migrations', schema: 'drizzle' },
  breakpoints: false,
  strict: true,
  verbose: true,
});
