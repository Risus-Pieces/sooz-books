/**
 * Log in as the end-to-end test account and screenshot pages of a running dev server.
 *
 *   npx tsx scripts/shoot.ts http://localhost:3100 /banking/review /banking/import
 *   npx tsx scripts/shoot.ts http://localhost:3100 /dashboard --mobile --out /tmp/shots
 *   npx tsx scripts/shoot.ts http://localhost:3100 /dashboard --mobile --dark   # light and dark
 *
 * Writes one PNG per route and viewport and prints each path, so a reviewer can open them.
 * Also reports, per route: the HTTP status, where it ended up after redirects, any console
 * error or uncaught page error, and whether the Next.js error overlay appeared. Exits 1 if
 * any route failed one of those checks, so it doubles as a smoke test.
 *
 * Credentials come from E2E_EMAIL / E2E_PASSWORD in .env.local (never from the command line).
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { config } from 'dotenv';
import { chromium, type Page } from '@playwright/test';

config({ path: '.env.local', override: false });

interface Args {
  base: string;
  routes: string[];
  out: string;
  mobile: boolean;
  dark: boolean;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let out = 'test-results/shots';
  let mobile = false;
  let dark = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') out = argv[++i] ?? out;
    else if (arg === '--mobile') mobile = true;
    else if (arg === '--dark') dark = true;
    else positional.push(arg);
  }
  const [base, ...routes] = positional;
  if (!base || routes.length === 0) {
    throw new Error('usage: npx tsx scripts/shoot.ts <baseUrl> <route> [route...] [--mobile] [--out dir]');
  }
  return { base: base.replace(/\/$/, ''), routes, out, mobile, dark };
}

async function logIn(page: Page, base: string): Promise<void> {
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;
  if (!email || !password) throw new Error('E2E_EMAIL and E2E_PASSWORD must be set in .env.local');

  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel(/email/i).first().fill(email);
  await page.getByLabel(/password/i).first().fill(password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 }),
    page.getByRole('button', { name: /sign in|log in|continue/i }).first().click(),
  ]);
}

function slug(route: string): string {
  return route.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/-$/, '') || 'root';
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });

  const sizes = [{ name: 'desktop', width: 1440, height: 900 }];
  if (args.mobile) sizes.push({ name: 'mobile', width: 390, height: 844 });
  const schemes: Array<'light' | 'dark'> = args.dark ? ['light', 'dark'] : ['light'];
  const viewports = sizes.flatMap((size) =>
    schemes.map((scheme) => ({ ...size, scheme, name: args.dark ? `${size.name}-${scheme}` : size.name })),
  );

  const browser = await chromium.launch();
  let failed = 0;
  try {
    for (const viewport of viewports) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: viewport.scheme,
      });
      const page = await context.newPage();
      await logIn(page, args.base);

      for (const route of args.routes) {
        const errors: string[] = [];
        const onConsole = (msg: { type(): string; text(): string }) => {
          if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
        };
        const onPageError = (err: Error) => errors.push(`pageerror: ${err.message}`);
        page.on('console', onConsole);
        page.on('pageerror', onPageError);

        const response = await page.goto(`${args.base}${route}`, { waitUntil: 'networkidle' });
        const status = response?.status() ?? 0;
        const landed = new URL(page.url()).pathname;
        // The error dialog itself, not <nextjs-portal>: that element is always mounted in
        // dev for the devtools badge, so matching it flags every healthy page.
        const overlay = await page
          .locator('[data-nextjs-dialog-content], [data-nextjs-error-overlay-nav], [data-nextjs-codeframe]')
          .count();

        const file = join(args.out, `${slug(route)}.${viewport.name}.png`);
        // caret: 'initial' — Playwright's default hides the caret by writing a style onto inputs,
        // and on a page still hydrating React reports that style as a hydration mismatch.
        await page.screenshot({ path: file, fullPage: true, caret: 'initial' });

        page.off('console', onConsole);
        page.off('pageerror', onPageError);

        const ok = status > 0 && status < 400 && overlay === 0 && errors.length === 0 && !landed.startsWith('/login');
        if (!ok) failed += 1;
        process.stdout.write(
          `${ok ? 'OK  ' : 'FAIL'} ${viewport.name.padEnd(13)} ${route} -> ${landed} [${status}]${overlay ? ' ERROR-OVERLAY' : ''}\n` +
            `     ${file}\n` +
            errors.map((e) => `     ${e.slice(0, 300)}\n`).join(''),
        );
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
