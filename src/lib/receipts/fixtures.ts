/**
 * The one guard for every test double the receipt assistant has (a fixed extractor, an
 * in-memory file store).
 *
 * The end-to-end run must neither call the model nor write to the real Supabase bucket, so it
 * sets `RECEIPT_FIXTURES=1`. That switch is honoured only outside production and outside
 * Vercel, so no misconfigured deployment can ever swap the real reader for a fixed one.
 */
export function devFixturesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RECEIPT_FIXTURES === '1' && env.NODE_ENV !== 'production' && !env.VERCEL;
}
