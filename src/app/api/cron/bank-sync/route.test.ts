import { afterEach, describe, expect, it } from 'vitest';

import { GET } from './route';

const ORIGINAL = process.env.CRON_SECRET;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL;
});

function call(authorization?: string): Request {
  return new Request('https://books.example/api/cron/bank-sync', { headers: authorization === undefined ? {} : { authorization } });
}

describe('the nightly sync endpoint', () => {
  it('refuses everyone when no secret is configured', async () => {
    delete process.env.CRON_SECRET;
    expect((await GET(call('Bearer '))).status).toBe(401);
    expect((await GET(call())).status).toBe(401);
  });

  it('refuses a missing or wrong secret', async () => {
    process.env.CRON_SECRET = 'the-real-secret';
    expect((await GET(call())).status).toBe(401);
    expect((await GET(call('Bearer the-real-secreT'))).status).toBe(401);
    expect((await GET(call('the-real-secret'))).status).toBe(401);
  });
});
