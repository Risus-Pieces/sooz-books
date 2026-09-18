import * as React from 'react';

import { cn } from '@/lib/cn';
import type { GlyphName } from '@/lib/ui/glyphs';
import type { Tint } from '@/lib/ui/tints';
import { IconBadge } from '@/components/ui/icon-badge';
import { InsetGroup, ListRow } from '@/components/ui/inset-group';
import { CompanyAvatar } from '@/components/shell/account-menu';
import type { PillTone } from '@/components/ui/pill';

export type RoleKey = 'owner' | 'bookkeeper' | 'approver' | 'viewer';

/** Each role owns one pill colour, the same in every list and sheet. */
export const ROLE_TONE: Record<RoleKey, PillTone> = {
  owner: 'purple',
  bookkeeper: 'blue',
  approver: 'orange',
  viewer: 'neutral',
};

export type SettingsPaneKey = 'company' | 'users' | 'appearance' | 'data';

export interface SettingsPane {
  key: SettingsPaneKey;
  label: string;
  href: string;
  glyph: GlyphName;
  tint: Tint;
}

/** System Settings' sidebar: one row per pane, each with its coloured badge. */
export const SETTINGS_PANES: readonly SettingsPane[] = [
  { key: 'company', label: 'Company', href: '/settings?pane=company', glyph: 'building', tint: 'blue' },
  { key: 'users', label: 'Users & Invites', href: '/settings/users', glyph: 'people', tint: 'indigo' },
  { key: 'appearance', label: 'Appearance', href: '/settings?pane=appearance', glyph: 'appearance', tint: 'gray' },
  { key: 'data', label: 'Data', href: '/settings?pane=data', glyph: 'doc-text', tint: 'teal' },
];

export function paneFor(key: SettingsPaneKey): SettingsPane {
  return SETTINGS_PANES.find((p) => p.key === key) ?? SETTINGS_PANES[0];
}

export function isPaneKey(value: string | undefined): value is SettingsPaneKey {
  return SETTINGS_PANES.some((p) => p.key === value);
}

/** The chosen pane's content column, centred beside the list on a desktop. */
export function PaneBody({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('mx-auto flex w-full max-w-[720px] flex-col gap-4 px-10 pt-4 pb-8 max-lg:px-0 max-lg:pt-0', className)}>
      {children}
    </div>
  );
}

/**
 * The Settings split: the pane list on the left and the chosen pane beside it (desktop). Below
 * 1024px it is one column, like iOS Settings: the list alone at /settings, the pane alone once one
 * is chosen. The company heads the list the way the Apple Account heads System Settings.
 */
export function SettingsSplit({
  current,
  paneOpen,
  companyName,
  extras,
  children,
}: {
  /** The pane shown, selected in the list. */
  current: SettingsPaneKey;
  /** True when the URL names the pane: below 1024px the pane replaces the list. */
  paneOpen: boolean;
  companyName: string;
  /** Quiet trailing words per pane in the list ("1"). */
  extras?: Partial<Record<SettingsPaneKey, React.ReactNode>>;
  children: React.ReactNode;
}) {
  const [company, ...rest] = SETTINGS_PANES;
  const trailing = (key: SettingsPaneKey, phone: boolean) =>
    extras?.[key] ? (
      <span className={phone ? 'text-sm font-normal text-label2' : 'text-xs font-medium opacity-80'}>{extras[key]}</span>
    ) : undefined;

  return (
    <div className="grid min-w-0 lg:min-h-[calc(100dvh-96px)] lg:grid-cols-[280px_minmax(0,1fr)] lg:overflow-clip lg:rounded-2xl lg:shadow-card">
      <nav
        aria-label="Settings"
        className={cn('min-w-0 lg:hairline-r lg:bg-card lg:px-2 lg:py-2.5', paneOpen && 'max-lg:hidden')}
      >
        {/* Desktop: a source list. */}
        <div className="flex flex-col gap-3 max-lg:hidden">
          <InsetGroup variant="plain">
            <ListRow
              href={company.href}
              selected={current === 'company'}
              leading={<CompanyAvatar size={36} />}
              title={companyName}
              subtitle={company.label}
            />
          </InsetGroup>
          <InsetGroup variant="plain" separatorInset={49}>
            {rest.map((pane) => (
              <ListRow
                key={pane.key}
                href={pane.href}
                selected={pane.key === current}
                leading={<IconBadge glyph={pane.glyph} tint={pane.tint} size="lg" />}
                title={pane.label}
                trailing={trailing(pane.key, false)}
              />
            ))}
          </InsetGroup>
        </div>
        {/* Phone and tablet: iOS Settings, rows with chevrons. */}
        <div className="flex flex-col gap-5 lg:hidden">
          <InsetGroup>
            <ListRow
              href={company.href}
              chevron
              leading={<CompanyAvatar size={56} />}
              title={<span className="text-xl font-semibold max-sm:text-xl">{companyName}</span>}
              subtitle={company.label}
            />
          </InsetGroup>
          <InsetGroup separatorInset={55}>
            {rest.map((pane) => (
              <ListRow
                key={pane.key}
                href={pane.href}
                chevron
                leading={<IconBadge glyph={pane.glyph} tint={pane.tint} size="lg" />}
                title={pane.label}
                trailing={trailing(pane.key, true)}
              />
            ))}
          </InsetGroup>
        </div>
      </nav>
      <div className={cn('min-w-0', !paneOpen && 'max-lg:hidden')}>{children}</div>
    </div>
  );
}
