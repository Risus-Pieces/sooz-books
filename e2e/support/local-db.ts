/**
 * A disposable copy of the Sooz Books schema for the end-to-end suite.
 *
 * The flows under test post journal entries, and a posted entry can never be deleted — the
 * triggers that make the ledger trustworthy make a committed test entry permanent. Running the
 * suite against the real books would leave its customers, bills and reversed entries in the
 * owner's journal on every run. So the suite gets a Postgres of its own: a local cluster,
 * rebuilt from `supabase/migrations/` at the start of every run, with the same triggers, seed
 * chart of accounts, vendors and rules as production, and none of the real Relay rows.
 *
 * Identity still comes from the real Supabase project: the browser signs in there as the E2E
 * account, and that account's `app_users` row is copied here so the app recognises it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import postgres from 'postgres';

export const E2E_PG_PORT = Number(process.env.E2E_PG_PORT ?? 54329);
const ROOT = resolve(__dirname, '..', '..');
// The unit-test suite runs its own cluster (vitest.global-setup.ts sets these) so a unit run
// and an e2e run never stop each other's Postgres.
const CLUSTER = process.env.LOCAL_PG_DIR ?? join(tmpdir(), 'sooz-books-e2e-pg');
const DATA_DIR = join(CLUSTER, 'data');
const SOCKET_DIR = join(CLUSTER, 'sock');
const LOG_FILE = join(CLUSTER, 'postgres.log');
const DB_NAME = process.env.LOCAL_PG_DB ?? 'sooz_e2e';
const APP_PASSWORD = 'sooz-e2e-local';

/** What the dev server connects as: the same non-superuser role production uses. */
export const E2E_DATABASE_URL = `postgres://sooz_app:${APP_PASSWORD}@127.0.0.1:${E2E_PG_PORT}/${DB_NAME}`;
/** A superuser connection, for the suite's own fixtures and clean-up. */
export const E2E_ADMIN_URL = `postgres://postgres@127.0.0.1:${E2E_PG_PORT}/${DB_NAME}`;

// Postgres on macOS refuses to start when it inherits a locale it cannot load.
const PG_ENV = { ...process.env, LC_ALL: 'C', LANG: 'C' };

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: PG_ENV });
}

function psql(database: string, args: string[], role = 'postgres'): void {
  const result = spawnSync(
    'psql',
    ['-X', '-q', '-h', '127.0.0.1', '-p', String(E2E_PG_PORT), '-U', role, '-d', database, '-v', 'ON_ERROR_STOP=1', ...args],
    { encoding: 'utf8', env: PG_ENV },
  );
  if (result.status !== 0) {
    throw new Error(`psql ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
}

function clusterRunning(): boolean {
  if (!existsSync(join(DATA_DIR, 'PG_VERSION'))) return false;
  const result = spawnSync('pg_ctl', ['-D', DATA_DIR, 'status'], { encoding: 'utf8', env: PG_ENV });
  return result.status === 0;
}

/** Creates the cluster on first use and starts it if it is not running. */
export function startCluster(): void {
  mkdirSync(SOCKET_DIR, { recursive: true });
  if (!existsSync(join(DATA_DIR, 'PG_VERSION'))) {
    run('initdb', ['-D', DATA_DIR, '-U', 'postgres', '--auth=trust', '--encoding=UTF8', '--locale=C']);
  }
  if (!clusterRunning()) {
    run('pg_ctl', [
      '-D',
      DATA_DIR,
      '-l',
      LOG_FILE,
      '-w',
      '-o',
      `-p ${E2E_PG_PORT} -k ${SOCKET_DIR} -c listen_addresses=127.0.0.1 -c fsync=off -c max_connections=60 -c timezone=UTC`,
      'start',
    ]);
  }
}

export function stopCluster(): void {
  if (clusterRunning()) run('pg_ctl', ['-D', DATA_DIR, '-m', 'fast', '-w', 'stop']);
}

/**
 * The parts of a Supabase project the migrations lean on and a bare Postgres lacks: the
 * platform roles, `auth.users` with `auth.uid()`, and the `storage` tables the statement
 * bucket is registered in.
 */
const PLATFORM_STUBS = `
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role', 'supabase_auth_admin', 'supabase_admin'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin', r);
    end if;
  end loop;
  if not exists (select 1 from pg_roles where rolname = 'sooz_app') then
    create role sooz_app login bypassrls password '${APP_PASSWORD}';
  end if;
end $$;

create schema if not exists extensions;
create schema if not exists auth;
create table if not exists auth.users (
  id                 uuid primary key,
  email              text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);
create or replace function auth.uid() returns uuid language sql stable as $f$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$f$;

create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid
);
alter table storage.objects enable row level security;

grant usage on schema auth to sooz_app;
grant references on auth.users to sooz_app;
grant usage, create on schema public to sooz_app;
`;

/**
 * Production applies most migrations through DATABASE_URL, i.e. as `sooz_app`, which therefore
 * owns the public schema; the few that reach into Supabase's own schemas or create roles are
 * run as `postgres`. The replay does the same, so ownership-sensitive statements behave alike.
 */
function needsSuperuser(sql: string): boolean {
  return /^\s*set role\b|\bstorage\.|\bcreate role\b|\bowner to\b/im.test(sql);
}

/**
 * After the migrations: production creates most tables as `sooz_app` itself, the local replay
 * runs as a superuser, so hand the app role what it owns there — and take the audit trail back
 * out of its hands exactly as 0016 does.
 */
const APP_GRANTS = `
grant all privileges on all tables in schema public to sooz_app;
grant all privileges on all sequences in schema public to sooz_app;
grant execute on all functions in schema public to sooz_app;
revoke all on audit_log from sooz_app;
revoke all on sequence audit_log_id_seq from sooz_app;
grant select on audit_log to sooz_app;
`;

export interface E2eUser {
  id: string;
  email: string;
  fullName: string | null;
}

/**
 * The E2E account's identity, read from the real project: the browser signs in there, so the
 * local `app_users` row has to carry the same id. One short read, never a write.
 */
export async function readE2eUser(liveUrl: string, email: string): Promise<E2eUser> {
  const live = postgres(liveUrl, { max: 1, idle_timeout: 5, connect_timeout: 30 });
  try {
    const rows = await live<{ id: string; email: string; full_name: string | null }[]>`
      select id, email, full_name from app_users where lower(email) = lower(${email}) limit 1`;
    const row = rows[0];
    if (!row) throw new Error(`The E2E account ${email} has no app_users row in the live project.`);
    return { id: row.id, email: row.email, fullName: row.full_name };
  } finally {
    await live.end({ timeout: 5 });
  }
}

/**
 * Drops and rebuilds the database from the migration files, then seeds the E2E owner when one
 * is given. The unit suite passes none: it signs nobody in, so it never reads the live project.
 */
export function rebuildDatabase(user?: E2eUser): void {
  psql('postgres', ['-c', `drop database if exists ${DB_NAME} with (force)`]);
  // Match production's collation exactly (ICU en-US over en_US.UTF-8, as the live pg_database row
  // shows). Under the C locale upper('Straße') keeps its ß, so normalize_description and every
  // bank-row fingerprint built on it would differ from production for non-ASCII payees.
  psql('postgres', [
    '-c',
    `create database ${DB_NAME} template template0 encoding 'UTF8' locale_provider icu icu_locale 'en-US' lc_collate 'en_US.UTF-8' lc_ctype 'en_US.UTF-8'`,
  ]);

  const stubs = join(CLUSTER, 'platform-stubs.sql');
  writeFileSync(stubs, PLATFORM_STUBS);
  psql(DB_NAME, ['-f', stubs]);
  psql(DB_NAME, ['-c', `grant create on database ${DB_NAME} to sooz_app`]);

  const dir = join(ROOT, 'supabase', 'migrations');
  const files = readdirSync(dir)
    .filter((name) => /^\d{4}_.*\.sql$/.test(name))
    .sort();
  for (const file of files) {
    try {
      const path = join(dir, file);
      psql(DB_NAME, ['--single-transaction', '-f', path], needsSuperuser(readFileSync(path, 'utf8')) ? 'postgres' : 'sooz_app');
    } catch (error) {
      throw new Error(`Migration ${file} failed on the e2e database: ${(error as Error).message}`);
    }
  }

  const grants = join(CLUSTER, 'app-grants.sql');
  const quote = (value: string | null): string => (value === null ? 'null' : `'${value.replace(/'/g, "''")}'`);
  const owner =
    user === undefined
      ? ''
      : `alter table auth.users disable trigger user;
insert into auth.users (id, email) values (${quote(user.id)}, ${quote(user.email)});
alter table auth.users enable trigger user;
insert into app_users (id, email, full_name, role) values (${quote(user.id)}, ${quote(user.email)}, ${quote(user.fullName)}, 'owner');
-- In a test database the seeded owner is the owner these books are configured for, so the
-- login page offers sign-in rather than the owner's one-time sign-up.
update app_settings set owner_email = ${quote(user.email)};
`;
  writeFileSync(grants, `${APP_GRANTS}\n${owner}`);
  psql(DB_NAME, ['-f', grants]);
}
