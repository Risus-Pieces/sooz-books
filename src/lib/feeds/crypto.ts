/**
 * Encryption at rest for Plaid access tokens.
 *
 * An access token reads the bank account it was issued for until it is revoked, so it is never stored
 * in plain text. AES-256-GCM with a key from `PLAID_TOKEN_KEY` (32 random bytes, base64) that lives
 * only in the environment: a copy of the database alone does not open the bank.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';

export class TokenKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenKeyError';
  }
}

function key(env: Readonly<Record<string, string | undefined>> = process.env): Buffer {
  const raw = env.PLAID_TOKEN_KEY;
  if (raw === undefined || raw === '') throw new TokenKeyError('PLAID_TOKEN_KEY is not set.');
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length !== 32) throw new TokenKeyError('PLAID_TOKEN_KEY must be 32 bytes, base64-encoded.');
  return bytes;
}

export function encryptToken(plain: string, env?: Readonly<Record<string, string | undefined>>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(env), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join(':');
}

export function decryptToken(sealed: string, env?: Readonly<Record<string, string | undefined>>): string {
  const [version, iv, tag, body] = sealed.split(':');
  if (version !== VERSION || iv === undefined || tag === undefined || body === undefined) {
    throw new TokenKeyError('That stored token is not in a format this version can read.');
  }
  const decipher = createDecipheriv('aes-256-gcm', key(env), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
}
