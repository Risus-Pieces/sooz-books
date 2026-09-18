import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { randomUUID } from 'node:crypto';

import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  createInvitedAccount,
  findOpenInvite,
  hashInviteToken,
  inviteStatus,
  issueInviteToken,
  recordInvite,
  reissueInvite,
  type AdminAuth,
} from './invites';

afterAll(closeTestDb);

const ORIGIN = 'https://books.example';
const DOMAIN = '@invite-test.invalid';

function tokenOf(link: string): string {
  return link.slice(link.indexOf('#invite=') + '#invite='.length);
}

async function ownerId(tx: Parameters<Parameters<typeof withRollback>[0]>[0]): Promise<string> {
  const [row] = await tx.execute<{ id: string }>(sql`select id from app_users where role = 'owner' limit 1`);
  return row.id;
}

function stubAdmin(overrides: Partial<AdminAuth> = {}): AdminAuth & {
  createUser: ReturnType<typeof vi.fn>;
  updateUserById: ReturnType<typeof vi.fn>;
} {
  return {
    createUser: vi.fn(async () => ({ data: { user: { id: randomUUID() } }, error: null })),
    updateUserById: vi.fn(async () => ({ error: null })),
    ...overrides,
  } as never;
}

describe('invite tokens', () => {
  it('are long, URL-safe and never repeat', () => {
    const a = issueInviteToken();
    const b = issueInviteToken();
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toBe(hashInviteToken(a.token));
  });
});

describe.skipIf(!hasDatabase)('invite links', () => {
  it('hash the token exactly as the database trigger does', async () => {
    await withRollback(async (tx) => {
      const { token, hash } = issueInviteToken();
      const [row] = await tx.execute<{ h: string }>(
        sql`select encode(sha256(convert_to(${token}, 'UTF8')), 'hex') as h`,
      );
      expect(row.h).toBe(hash);
    });
  });

  it('carry the token in the fragment, store only its hash, and expire in a week', async () => {
    await withRollback(async (tx) => {
      const link = await recordInvite(tx, {
        email: `mo${DOMAIN}`,
        role: 'owner',
        invitedBy: await ownerId(tx),
        origin: ORIGIN,
      });
      expect(link.link).toMatch(new RegExp(`^${ORIGIN}/login\\?stage=join#invite=[A-Za-z0-9_-]{43}$`));
      const token = tokenOf(link.link);

      const [stored] = await tx.execute<{ token_hash: string; days: number }>(sql`
        select token_hash, round(extract(epoch from expires_at - now()) / 86400)::int as days
          from app_invites where email = ${`mo${DOMAIN}`}`);
      expect(stored.token_hash).toBe(hashInviteToken(token));
      expect(stored.token_hash).not.toContain(token);
      expect(stored.days).toBe(7);

      expect(await findOpenInvite(tx, token)).toMatchObject({ email: `mo${DOMAIN}`, role: 'owner' });
    });
  });

  it('stop working when re-issued or re-invited: only the newest link opens anything', async () => {
    await withRollback(async (tx) => {
      const invitedBy = await ownerId(tx);
      const first = await recordInvite(tx, { email: `mo${DOMAIN}`, role: 'viewer', invitedBy, origin: ORIGIN });
      const second = await recordInvite(tx, { email: `mo${DOMAIN}`, role: 'bookkeeper', invitedBy, origin: ORIGIN });
      expect(await findOpenInvite(tx, tokenOf(first.link))).toBeNull();
      expect(await findOpenInvite(tx, tokenOf(second.link))).toMatchObject({ role: 'bookkeeper' });

      const [invite] = await tx.execute<{ id: string }>(sql`select id from app_invites where email = ${`mo${DOMAIN}`}`);
      const third = await reissueInvite(tx, { inviteId: invite.id, origin: ORIGIN });
      expect(third).not.toBeNull();
      expect(await findOpenInvite(tx, tokenOf(second.link))).toBeNull();
      expect(await findOpenInvite(tx, tokenOf(third?.link ?? ''))).toMatchObject({ role: 'bookkeeper' });
    });
  });

  it('do not open an expired or already used invitation, or a made-up token', async () => {
    await withRollback(async (tx) => {
      const invitedBy = await ownerId(tx);
      const expired = await recordInvite(tx, { email: `old${DOMAIN}`, role: 'viewer', invitedBy, origin: ORIGIN });
      await tx.execute(sql`update app_invites set expires_at = now() - interval '1 minute' where email = ${`old${DOMAIN}`}`);
      const used = await recordInvite(tx, { email: `used${DOMAIN}`, role: 'viewer', invitedBy, origin: ORIGIN });
      await tx.execute(sql`update app_invites set accepted_at = now() where email = ${`used${DOMAIN}`}`);

      expect(await findOpenInvite(tx, tokenOf(expired.link))).toBeNull();
      expect(await findOpenInvite(tx, tokenOf(used.link))).toBeNull();
      expect(await findOpenInvite(tx, issueInviteToken().token)).toBeNull();
      expect(await findOpenInvite(tx, 'short')).toBeNull();
    });
  });

  it('create the account for the invited address — never one the visitor typed — already confirmed', async () => {
    await withRollback(async (tx) => {
      const link = await recordInvite(tx, { email: `mo${DOMAIN}`, role: 'owner', invitedBy: await ownerId(tx), origin: ORIGIN });
      const admin = stubAdmin();

      const outcome = await createInvitedAccount(tx, admin, {
        token: tokenOf(link.link),
        fullName: 'Mo',
        password: 'a-long-password',
      });

      expect(outcome).toEqual({ ok: true, email: `mo${DOMAIN}` });
      expect(admin.createUser).toHaveBeenCalledWith({
        email: `mo${DOMAIN}`,
        password: 'a-long-password',
        email_confirm: true,
        user_metadata: { full_name: 'Mo', invite_token: tokenOf(link.link) },
      });
      // The spent token is scrubbed from what the session will carry.
      expect(admin.updateUserById).toHaveBeenCalledWith(expect.any(String), { user_metadata: { invite_token: null } });
    });
  });

  it('send someone whose join already created the account to sign in, not back to the owner', async () => {
    await withRollback(async (tx) => {
      const link = await recordInvite(tx, { email: `half${DOMAIN}`, role: 'viewer', invitedBy: await ownerId(tx), origin: ORIGIN });
      await tx.execute(sql`update app_invites set accepted_at = now() where email = ${`half${DOMAIN}`}`);
      const admin = stubAdmin();

      expect(await inviteStatus(tx, tokenOf(link.link))).toEqual({ state: 'used' });
      expect(await createInvitedAccount(tx, admin, { token: tokenOf(link.link), fullName: 'X', password: 'a-long-password' }))
        .toEqual({ ok: false, reason: 'already_registered' });
      expect(admin.createUser).not.toHaveBeenCalled();
      expect(await inviteStatus(tx, issueInviteToken().token)).toEqual({ state: 'invalid' });
    });
  });

  it('keep an account that was created even if scrubbing the spent token fails', async () => {
    await withRollback(async (tx) => {
      const link = await recordInvite(tx, { email: `scrub${DOMAIN}`, role: 'viewer', invitedBy: await ownerId(tx), origin: ORIGIN });
      const admin = stubAdmin({ updateUserById: vi.fn(async () => { throw new Error('network'); }) });
      expect(await createInvitedAccount(tx, admin, { token: tokenOf(link.link), fullName: 'X', password: 'a-long-password' }))
        .toEqual({ ok: true, email: `scrub${DOMAIN}` });
    });
  });

  it('refuse a bad link without ever calling Supabase, and read Supabase refusals plainly', async () => {
    await withRollback(async (tx) => {
      const admin = stubAdmin();
      expect(await createInvitedAccount(tx, admin, { token: issueInviteToken().token, fullName: 'X', password: 'a-long-password' }))
        .toEqual({ ok: false, reason: 'invalid_link' });
      expect(admin.createUser).not.toHaveBeenCalled();

      const invitedBy = await ownerId(tx);
      const registered = await recordInvite(tx, { email: `taken${DOMAIN}`, role: 'viewer', invitedBy, origin: ORIGIN });
      const taken = stubAdmin({
        createUser: vi.fn(async () => ({ data: { user: null }, error: { message: 'A user with this email address has already been registered' } })),
      });
      expect(await createInvitedAccount(tx, taken, { token: tokenOf(registered.link), fullName: 'X', password: 'a-long-password' }))
        .toEqual({ ok: false, reason: 'already_registered' });

      const raced = await recordInvite(tx, { email: `raced${DOMAIN}`, role: 'viewer', invitedBy, origin: ORIGIN });
      const refused = stubAdmin({
        createUser: vi.fn(async () => ({ data: { user: null }, error: { message: 'Database error creating new user' } })),
      });
      expect(await createInvitedAccount(tx, refused, { token: tokenOf(raced.link), fullName: 'X', password: 'a-long-password' }))
        .toEqual({ ok: false, reason: 'invalid_link' });
    });
  });
});

/**
 * The trigger on auth.users is the gatekeeper, because Supabase's sign-up endpoint is public.
 * These inserts are exactly what Supabase performs, run as postgres on the disposable database and
 * rolled back. They reproduce the three impostor attempts that were also made against production.
 */
describe.skipIf(!hasDatabase)('the sign-up trigger', () => {
  const adminUrl = (process.env.DATABASE_URL ?? '').replace(/^postgres(ql)?:\/\/[^@]+@/, 'postgres://postgres@');

  async function attempt(
    setup: (sq: postgres.TransactionSql) => Promise<string>,
    email: string,
    metadata: (token: string) => Record<string, unknown>,
  ): Promise<{ created: boolean; role?: string; accepted?: boolean; error?: string }> {
    const client = postgres(adminUrl, { max: 1, onnotice: () => {} });
    const ROLLBACK = new Error('rollback');
    let outcome: { created: boolean; role?: string; accepted?: boolean; error?: string } = { created: false };
    try {
      await client.begin(async (sq) => {
        const token = await setup(sq);
        const id = randomUUID();
        try {
          await sq.savepoint(async (sp) => {
            await sp`insert into auth.users (id, email, raw_user_meta_data) values (${id}, ${email}, ${sq.json(metadata(token) as never)})`;
          });
          const [row] = await sq<{ role: string; accepted: boolean }[]>`
            select u.role, (i.accepted_at is not null) as accepted
              from app_users u left join app_invites i on i.accepted_by = u.id where u.id = ${id}`;
          outcome = { created: true, role: row?.role, accepted: row?.accepted };
        } catch (error) {
          outcome = { created: false, error: (error as Error).message };
        }
        throw ROLLBACK;
      });
    } catch (error) {
      if (error !== ROLLBACK) throw error;
    } finally {
      await client.end({ timeout: 5 });
    }
    return outcome;
  }

  async function openInvite(sq: postgres.TransactionSql, email: string, expiresIn = '1 hour'): Promise<string> {
    const { token, hash } = issueInviteToken();
    await sq`insert into app_invites (email, role, token_hash, expires_at)
             values (${email}, 'owner', ${hash}, now() + ${expiresIn}::interval)`;
    return token;
  }

  it('refuses an invited address with no token', async () => {
    const r = await attempt((sq) => openInvite(sq, `mo${DOMAIN}`), `mo${DOMAIN}`, () => ({}));
    expect(r.created).toBe(false);
    expect(r.error).toMatch(/invitation only/);
  });

  it('refuses an invited address with a guessed token', async () => {
    const r = await attempt((sq) => openInvite(sq, `mo${DOMAIN}`), `mo${DOMAIN}`, () => ({ invite_token: issueInviteToken().token }));
    expect(r.created).toBe(false);
  });

  it('refuses the right token on a different address', async () => {
    const r = await attempt((sq) => openInvite(sq, `mo${DOMAIN}`), `thief${DOMAIN}`, (token) => ({ invite_token: token }));
    expect(r.created).toBe(false);
  });

  it('refuses an expired invitation even with its token', async () => {
    const r = await attempt((sq) => openInvite(sq, `mo${DOMAIN}`, '-1 minute'), `mo${DOMAIN}`, (token) => ({ invite_token: token }));
    expect(r.created).toBe(false);
  });

  it('refuses an invitation made before links existed', async () => {
    const r = await attempt(async (sq) => {
      await sq`insert into app_invites (email, role) values (${`legacy${DOMAIN}`}, 'owner')`;
      return 'irrelevant-token-value-000000';
    }, `legacy${DOMAIN}`, (token) => ({ invite_token: token }));
    expect(r.created).toBe(false);
  });

  it('accepts the right token for its own address, with the invitation\'s role, and spends it', async () => {
    const r = await attempt((sq) => openInvite(sq, `mo${DOMAIN}`), `MO${DOMAIN.toUpperCase()}`, (token) => ({ invite_token: token, full_name: 'Mo' }));
    expect(r).toMatchObject({ created: true, role: 'owner', accepted: true });
  });
});
