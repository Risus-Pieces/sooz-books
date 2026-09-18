'use client';

import * as React from 'react';

import { cn } from '@/lib/cn';
import { useTheme, type ThemePreference } from '@/components/ui/theme';

const CHOICES: Array<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/**
 * A miniature window: sidebar, title bar and two cards. The colours are the system's light and dark
 * values written out, because each thumbnail must show its appearance whichever one is current.
 */
function Window({ dark }: { dark: boolean }) {
  const c = dark
    ? { bg: '#1c1c1e', side: '#2c2c2e', card: '#3a3a3c', line: '#636366', accent: '#0a84ff' }
    : { bg: '#f2f2f7', side: '#e5e5ea', card: '#ffffff', line: '#c7c7cc', accent: '#007aff' };
  return (
    <>
      <rect width="120" height="80" fill={c.bg} />
      <rect width="34" height="80" fill={c.side} />
      <circle cx="7" cy="7" r="2" fill="#ff5f57" />
      <circle cx="13" cy="7" r="2" fill="#febc2e" />
      <circle cx="19" cy="7" r="2" fill="#28c840" />
      <rect x="5" y="16" width="24" height="5" rx="2" fill={c.accent} />
      <rect x="5" y="25" width="18" height="3" rx="1.5" fill={c.line} />
      <rect x="5" y="31" width="21" height="3" rx="1.5" fill={c.line} />
      <rect x="5" y="37" width="15" height="3" rx="1.5" fill={c.line} />
      <rect x="40" y="6" width="30" height="5" rx="2" fill={c.line} />
      <rect x="40" y="17" width="74" height="26" rx="4" fill={c.card} />
      <path d="M45 37 L58 30 L70 33 L84 24 L108 28" fill="none" stroke={c.accent} strokeWidth="1.8" strokeLinecap="round" />
      <rect x="40" y="48" width="35" height="26" rx="4" fill={c.card} />
      <rect x="79" y="48" width="35" height="26" rx="4" fill={c.card} />
    </>
  );
}

function Preview({ value }: { value: ThemePreference }) {
  const id = React.useId();
  return (
    <svg viewBox="0 0 120 80" className="block h-auto w-full" aria-hidden>
      {value === 'system' ? (
        <>
          <defs>
            <clipPath id={`${id}-left`}>
              <path d="M0 0 H72 L48 80 H0 Z" />
            </clipPath>
            <clipPath id={`${id}-right`}>
              <path d="M72 0 H120 V80 H48 Z" />
            </clipPath>
          </defs>
          <g clipPath={`url(#${id}-left)`}>
            <Window dark={false} />
          </g>
          <g clipPath={`url(#${id}-right)`}>
            <Window dark />
          </g>
        </>
      ) : (
        <Window dark={value === 'dark'} />
      )}
    </svg>
  );
}

/** System Settings' Appearance choice: three window thumbnails, the chosen one ringed in blue. */
export function AppearancePicker() {
  const { preference: current, setPreference } = useTheme();

  return (
    <div role="group" aria-label="Appearance" className="grid grid-cols-3 gap-4 px-4 py-4 max-sm:gap-3">
      {CHOICES.map((choice) => {
        const checked = current === choice.value;
        return (
          <button
            key={choice.value}
            type="button"
            aria-pressed={checked}
            onClick={() => setPreference(choice.value)}
            className="group flex min-h-11 flex-col items-center gap-2 rounded-[10px] outline-none focus-ring"
          >
            <span
              className={cn(
                'block w-full overflow-hidden rounded-[9px] shadow-[0_0_0_0.5px_var(--sep-strong)] transition-shadow duration-150',
                checked
                  ? 'shadow-[0_0_0_3px_var(--blue)]'
                  : 'group-hover:shadow-[0_0_0_3px_color-mix(in_srgb,var(--label3)_60%,transparent)] group-focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--blue)_55%,transparent)]',
              )}
            >
              <Preview value={choice.value} />
            </span>
            <span className={cn('text-xs font-medium', checked ? 'font-semibold text-label' : 'text-label2')}>
              {choice.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
