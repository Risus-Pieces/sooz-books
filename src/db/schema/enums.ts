import { pgEnum } from 'drizzle-orm/pg-core';

import { APP_ROLES } from '@/lib/types';

export const accountTypeEnum = pgEnum('account_type', [
  'asset',
  'liability',
  'equity',
  'revenue',
  'expense',
]);

export const jeStatusEnum = pgEnum('je_status', ['draft', 'posted']);

export const periodStatusEnum = pgEnum('period_status', ['open', 'closed']);

export const appRoleEnum = pgEnum('app_role', APP_ROLES);

export type AccountType = (typeof accountTypeEnum.enumValues)[number];
export type JeStatus = (typeof jeStatusEnum.enumValues)[number];
export type PeriodStatus = (typeof periodStatusEnum.enumValues)[number];
