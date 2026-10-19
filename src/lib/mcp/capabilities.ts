import type { Capability } from '@/lib/auth/roles';

/**
 * What Claude can ever do through the connector: a subset of any role. Closing or re-opening
 * periods, deleting or reversing entries, and managing users are deliberately absent; a person's role
 * can only narrow this further.
 */
export const CONNECTOR_CAPABILITIES: readonly Capability[] = [
  'reports.view',
  'bank.import',
  'bank.approve',
  'ledger.post',
  'settings.manage',
];
