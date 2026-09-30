import { describe, expect, it } from 'vitest';

import { ForbiddenError } from '@/lib/auth/roles';
import { ClosedPeriodError } from '@/lib/ledger/errors';

import { ExtractionError } from './extractor';
import { toActionFailure } from './failure';
import { ReceiptError } from './post';

describe('toActionFailure', () => {
  it('passes on the words and code of a refusal made to be read', () => {
    expect(toActionFailure(new ReceiptError('blocked', 'Choose which member paid.'))).toEqual({
      code: 'blocked',
      message: 'Choose which member paid.',
    });
    expect(toActionFailure(new ExtractionError('timeout', 'Took too long.'))).toEqual({
      code: 'timeout',
      message: 'Took too long.',
    });
    expect(toActionFailure(new ForbiddenError('viewer', 'ledger.post'))).toEqual({
      code: 'forbidden',
      message: 'A viewer may not post to the ledger.',
    });
  });

  it("passes on the ledger's own words, such as a closed period", () => {
    const failure = toActionFailure(new ClosedPeriodError(2026, 3, '2026-03-10'));

    expect(failure.code).toBe('closed_period');
    expect(failure.message).toMatch(/closed/);
  });

  it('says something plain for anything else, and never leaks its text', () => {
    expect(toActionFailure(new Error('connection to server at "db.internal" failed'))).toEqual({
      code: 'unexpected',
      message: 'Something went wrong. Try again.',
    });
    expect(toActionFailure('weird').code).toBe('unexpected');
  });
});
