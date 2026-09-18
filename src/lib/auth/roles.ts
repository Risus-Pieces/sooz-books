/**
 * What each role may do, expressed once.
 *
 * Every guard in the application — server actions, page shells, the API surface — asks this
 * module rather than comparing role strings, so widening a role is a one-line change here and
 * an auditor can read the whole authorisation policy on one screen.
 *
 * Nothing in this file may import from `@/db` or `next/*`: it is pure data plus two functions,
 * which is what lets the client render the right controls from the same table the server
 * enforces.
 */

import type { AppRole } from '@/lib/types';

export type Capability =
  /** Write a journal entry into the ledger, including reversals. */
  | 'ledger.post'
  /** Close an accounting period. */
  | 'ledger.close'
  /** Re-open a closed period — a restatement, so it is owner-only. */
  | 'ledger.reopen'
  /** Load a bank statement and work the review queue. */
  | 'bank.import'
  /** Approve a categorised bank transaction so it posts. */
  | 'bank.approve'
  /** Invoices, customers, receipts, credit memos. */
  | 'ar.manage'
  /** Bills, vendors, purchase approvals. */
  | 'ap.manage'
  /** Release money to a vendor. */
  | 'ap.pay'
  /** Promotions, deductions, trade accruals. */
  | 'trade.manage'
  /** Inventory counts, valuations, COGS batches. */
  | 'inventory.manage'
  /** Read any report. */
  | 'reports.view'
  /** Chart of accounts, channels, products, import profiles. */
  | 'settings.manage'
  /** Invite people, change roles, switch access off. */
  | 'users.manage';

export const CAPABILITIES: Record<AppRole, readonly Capability[]> = {
  // The owner is the only role that can restate a closed period, reshape the chart of
  // accounts, or grant access — the three powers that change what the books mean.
  owner: [
    'ledger.post',
    'ledger.close',
    'ledger.reopen',
    'bank.import',
    'bank.approve',
    'ar.manage',
    'ap.manage',
    'ap.pay',
    'trade.manage',
    'inventory.manage',
    'reports.view',
    'settings.manage',
    'users.manage',
  ],
  // Does the books day to day: everything operational, nothing constitutional.
  bookkeeper: [
    'ledger.post',
    'ledger.close',
    'bank.import',
    'bank.approve',
    'ar.manage',
    'ap.manage',
    'ap.pay',
    'trade.manage',
    'inventory.manage',
    'reports.view',
  ],
  // Reviews and releases work someone else prepared.
  approver: ['ledger.post', 'bank.approve', 'ap.pay', 'reports.view'],
  viewer: ['reports.view'],
};

export function can(role: AppRole, cap: Capability): boolean {
  return CAPABILITIES[role].includes(cap);
}

/** Thrown by the guards. Server actions catch it and return the message; pages let it 403. */
export class ForbiddenError extends Error {
  readonly role: AppRole;
  readonly capability: Capability;

  constructor(role: AppRole, capability: Capability) {
    super(`A ${role} may not ${CAPABILITY_LABELS[capability]}.`);
    this.name = 'ForbiddenError';
    this.role = role;
    this.capability = capability;
  }
}

export function isForbiddenError(error: unknown): error is ForbiddenError {
  return error instanceof ForbiddenError;
}

/**
 * Asserts a role holds a capability. `requireCapability` in `@/lib/auth/session` is the wrapper
 * server actions reach for; this is the pure check underneath it, for code that already knows
 * whose role it is holding.
 */
export function requireCapability(role: AppRole, cap: Capability): void {
  if (!can(role, cap)) throw new ForbiddenError(role, cap);
}

/** Verb phrases, used to build error messages that read as sentences. */
const CAPABILITY_LABELS: Record<Capability, string> = {
  'ledger.post': 'post to the ledger',
  'ledger.close': 'close a period',
  'ledger.reopen': 're-open a closed period',
  'bank.import': 'import bank activity',
  'bank.approve': 'approve bank transactions',
  'ar.manage': 'manage receivables',
  'ap.manage': 'manage payables',
  'ap.pay': 'pay vendors',
  'trade.manage': 'manage trade spend',
  'inventory.manage': 'manage inventory',
  'reports.view': 'view reports',
  'settings.manage': 'change settings',
  'users.manage': 'manage users',
};

/** Shown wherever a role has to be named in the interface. */
export const ROLE_LABELS: Record<AppRole, string> = {
  owner: 'Owner',
  bookkeeper: 'Bookkeeper',
  approver: 'Approver',
  viewer: 'Viewer',
};

export const ROLE_DESCRIPTIONS: Record<AppRole, string> = {
  owner: 'Full access, including users, settings and re-opening closed periods.',
  bookkeeper: 'Runs the books: imports, invoices, bills, inventory, posting and close.',
  approver: 'Reviews and releases — approves bank activity and vendor payments.',
  viewer: 'Read-only access to reports.',
};
