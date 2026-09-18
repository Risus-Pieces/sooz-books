import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { NAV_GROUPS, activeSectionHref, labelForPath } from '@/components/shell/nav';

const APP_DIR = resolve(__dirname, '../../app');

/**
 * Every URL path the App Router can render, read off the file tree. Route groups such as
 * `(app)` add a directory but no path segment, so they are dropped from the path.
 */
function routablePaths(dir: string = APP_DIR, segments: string[] = []): Set<string> {
  const paths = new Set<string>();
  if (existsSync(join(dir, 'page.tsx'))) paths.add(`/${segments.join('/')}`);

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const isGroup = entry.name.startsWith('(') && entry.name.endsWith(')');
    const next = isGroup ? segments : [...segments, entry.name];
    for (const path of routablePaths(join(dir, entry.name), next)) paths.add(path);
  }
  return paths;
}

const hrefs = NAV_GROUPS.flatMap((group) =>
  group.sections.flatMap((section) => [
    section.href,
    ...(section.children ?? []).map((child) => child.href),
  ]),
);

describe('navigation', () => {
  const routes = routablePaths();

  it.each(hrefs)('links %s to a page that exists', (href) => {
    expect(routes.has(href)).toBe(true);
  });

  it('never lists the same destination twice', () => {
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('gives every parent segment of a nested link its own page, so breadcrumbs never 404', () => {
    for (const href of hrefs) {
      const segments = href.split('/').filter(Boolean);
      for (let depth = 1; depth < segments.length; depth += 1) {
        expect(routes.has(`/${segments.slice(0, depth).join('/')}`)).toBe(true);
      }
    }
  });

  it('groups the sidebar as Home · Review · Banking · Business · Books · Settings', () => {
    expect(NAV_GROUPS.map((g) => g.label ?? g.key)).toEqual(['top', 'Banking', 'Business', 'Books', 'footer']);
    expect(NAV_GROUPS[0].sections.map((s) => s.label)).toEqual(['Home', 'Review']);
    expect(NAV_GROUPS[3].sections.map((s) => s.label)).toEqual(['Ledger', 'Reports', 'Close', 'Plan']);
  });

  it('selects the most specific section for a path', () => {
    expect(activeSectionHref('/banking/review')).toBe('/banking/review');
    expect(activeSectionHref('/banking/import')).toBe('/banking');
    expect(activeSectionHref('/banking')).toBe('/banking');
    expect(activeSectionHref('/reports/margin')).toBe('/inventory');
    expect(activeSectionHref('/reports/profit-loss')).toBe('/reports');
    expect(activeSectionHref('/sales/invoices/abc')).toBe('/sales');
    expect(activeSectionHref('/nowhere')).toBeNull();
  });

  it('labels a child link by its own name', () => {
    expect(labelForPath('/ledger/accounts')).toBe('Chart of Accounts');
    expect(labelForPath('/reports/profit-loss')).toBe('P&L');
    expect(labelForPath('/nowhere')).toBeNull();
  });
});
