/**
 * Flow 5 — the books are invite-only. A stranger who reaches the login page and tries to get
 * an account is refused, and told why in words a person can act on.
 *
 * Runs signed out. The sign-up attempts go to the real Supabase project (that is where
 * identities live) and are refused inside the transaction that would have created them, so
 * no account survives; the addresses are on the reserved `.invalid` domain.
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { expect, test } from './support/test';

config({ path: '.env.local', override: false, quiet: true });

function strangerEmail(): string {
  return `uninvited-${Date.now()}-${Math.floor(Math.random() * 1e6)}@sooz-books.invalid`;
}

test.describe('invite-only sign-up', () => {
  test('asking for a sign-in link with an uninvited address is refused on the login page', async ({ page }) => {
    const email = strangerEmail();
    await page.goto('/login', { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: 'Email link' }).click();
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Email me a link' }).click();

    const alert = page.getByRole('main').getByRole('alert');
    await expect(alert).toHaveText('No account here uses that address. Ask an owner to invite you.');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText(/a sign-in link is on its way/i)).toHaveCount(0);
  });

  test('a password sign-in for an address with no account is refused, not created', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'networkidle' });
    await page.getByLabel('Email').fill(strangerEmail());
    await page.getByLabel('Password').fill('Str4nger-password-2026');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('main').getByRole('alert')).toHaveText('That email and password do not match an account.');
    await expect(page).toHaveURL(/\/login/);
  });

  test('a direct sign-up is refused by the database, and the redirect it causes reads plainly', async ({ page }) => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anonKey) throw new Error('NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set');

    // What anyone holding the public anon key can attempt, bypassing the login page entirely.
    const supabase = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await supabase.auth.signUp({ email: strangerEmail(), password: 'Str4nger-password-2026' });
    expect(error, 'an uninvited sign-up must be refused').not.toBeNull();
    expect(data.user).toBeNull();
    const refusal = error?.message ?? '';
    expect(refusal).toMatch(/database error saving new user/i);

    // A sign-up started from an emailed or OAuth link comes back through the callback with
    // Supabase's own words for that refusal. The login page must not show them raw.
    const params = new URLSearchParams({
      error: 'server_error',
      error_code: 'unexpected_failure',
      error_description: refusal,
    });
    await page.goto(`/auth/callback?${params.toString()}`);
    await expect(page).toHaveURL(/\/login/);
    const alert = page.getByRole('main').getByRole('alert');
    await expect(alert).toContainText('Sign-up is by invitation only');
    await expect(alert).not.toContainText(/database error/i);
  });
});
