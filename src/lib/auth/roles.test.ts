import { describe, expect, it } from 'vitest';

import {
  CAPABILITIES,
  ForbiddenError,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  can,
  isForbiddenError,
  requireCapability,
  type Capability,
} from '@/lib/auth/roles';
import { APP_ROLES, type AppRole } from '@/lib/types';

/**
 * The authorisation policy, written out longhand. Every role against every capability, with the
 * expected answer spelled as a literal rather than derived from CAPABILITIES — a test that
 * recomputed the table from the table would pass no matter what the table said.
 */
const MATRIX: Record<Capability, Record<AppRole, boolean>> = {
  'ledger.post': { owner: true, bookkeeper: true, approver: true, viewer: false },
  'ledger.close': { owner: true, bookkeeper: true, approver: false, viewer: false },
  'ledger.reopen': { owner: true, bookkeeper: false, approver: false, viewer: false },
  'bank.import': { owner: true, bookkeeper: true, approver: false, viewer: false },
  'bank.approve': { owner: true, bookkeeper: true, approver: true, viewer: false },
  'ar.manage': { owner: true, bookkeeper: true, approver: false, viewer: false },
  'ap.manage': { owner: true, bookkeeper: true, approver: false, viewer: false },
  'ap.pay': { owner: true, bookkeeper: true, approver: true, viewer: false },
  'trade.manage': { owner: true, bookkeeper: true, approver: false, viewer: false },
  'inventory.manage': { owner: true, bookkeeper: true, approver: false, viewer: false },
  'reports.view': { owner: true, bookkeeper: true, approver: true, viewer: true },
  'settings.manage': { owner: true, bookkeeper: false, approver: false, viewer: false },
  'users.manage': { owner: true, bookkeeper: false, approver: false, viewer: false },
};

const ALL_CAPABILITIES = Object.keys(MATRIX) as Capability[];

describe('can', () => {
  for (const cap of ALL_CAPABILITIES) {
    for (const role of APP_ROLES) {
      const expected = MATRIX[cap][role];
      it(`${role} ${expected ? 'can' : 'cannot'} ${cap}`, () => {
        expect(can(role, cap)).toBe(expected);
      });
    }
  }
});

describe('the capability table', () => {
  it('covers every role', () => {
    expect(Object.keys(CAPABILITIES).sort()).toEqual([...APP_ROLES].sort());
  });

  it('grants each role exactly the capabilities the matrix says', () => {
    for (const role of APP_ROLES) {
      const granted = ALL_CAPABILITIES.filter((cap) => MATRIX[cap][role]);
      expect([...CAPABILITIES[role]].sort()).toEqual(granted.sort());
    }
  });

  it('names no capability outside the declared set', () => {
    for (const role of APP_ROLES) {
      for (const cap of CAPABILITIES[role]) {
        expect(ALL_CAPABILITIES).toContain(cap);
      }
    }
  });

  it('lists no capability twice for a role', () => {
    for (const role of APP_ROLES) {
      expect(new Set(CAPABILITIES[role]).size).toBe(CAPABILITIES[role].length);
    }
  });

  it('gives the owner everything', () => {
    expect([...CAPABILITIES.owner].sort()).toEqual([...ALL_CAPABILITIES].sort());
  });

  it('withholds exactly users.manage, ledger.reopen and settings.manage from the bookkeeper', () => {
    const withheld = ALL_CAPABILITIES.filter((cap) => !can('bookkeeper', cap));
    expect(withheld.sort()).toEqual(
      ['ledger.reopen', 'settings.manage', 'users.manage'].sort(),
    );
  });

  it('leaves the viewer read-only', () => {
    expect(CAPABILITIES.viewer).toEqual(['reports.view']);
  });

  it('narrows monotonically from owner through viewer for the shared capabilities', () => {
    // Not a strict subset chain — an approver may pay where a viewer may not — but every role
    // must sit inside the owner's grant, or the owner could be locked out of part of the app.
    for (const role of APP_ROLES) {
      for (const cap of CAPABILITIES[role]) {
        expect(can('owner', cap)).toBe(true);
      }
    }
  });
});

describe('requireCapability', () => {
  it('returns quietly when the role holds the capability', () => {
    expect(() => requireCapability('bookkeeper', 'ledger.post')).not.toThrow();
  });

  it('throws ForbiddenError naming the role and capability', () => {
    let thrown: unknown;
    try {
      requireCapability('viewer', 'ledger.post');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenError);
    expect(isForbiddenError(thrown)).toBe(true);
    const forbidden = thrown as ForbiddenError;
    expect(forbidden.role).toBe('viewer');
    expect(forbidden.capability).toBe('ledger.post');
    expect(forbidden.name).toBe('ForbiddenError');
    expect(forbidden.message).toBe('A viewer may not post to the ledger.');
  });

  it('throws for every role/capability pair the matrix denies', () => {
    for (const cap of ALL_CAPABILITIES) {
      for (const role of APP_ROLES) {
        if (MATRIX[cap][role]) continue;
        expect(() => requireCapability(role, cap)).toThrow(ForbiddenError);
      }
    }
  });
});

describe('isForbiddenError', () => {
  it('rejects other errors', () => {
    expect(isForbiddenError(new Error('nope'))).toBe(false);
    expect(isForbiddenError(null)).toBe(false);
    expect(isForbiddenError('ForbiddenError')).toBe(false);
  });
});

describe('role copy', () => {
  it('labels and describes every role', () => {
    for (const role of APP_ROLES) {
      expect(ROLE_LABELS[role]).toBeTruthy();
      expect(ROLE_DESCRIPTIONS[role]).toBeTruthy();
    }
  });
});
