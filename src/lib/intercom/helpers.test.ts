import {
  isSpendingLimitPriceUnavailable,
  spendingLimitAssessmentFromError,
  SpendingLimitAuthorizationRequiredError,
  SpendingLimitPriceUnavailableError,
  type SpendingLimitAssessment
} from 'lib/miden/spending-limits/types';

import { DEFAULT_ERROR_MESSAGE, deserializeError, IntercomError, serializeError, serializeErrorForPage } from './helpers';

describe('intercom helpers', () => {
  it('serializes plain errors and arrays', () => {
    expect(serializeError(new Error('boom'))).toBe('boom');
    expect(serializeError({})).toBe(DEFAULT_ERROR_MESSAGE);
    expect(serializeError({ message: 'bad', errors: ['x'] })).toEqual(['bad', ['x']]);
  });

  it('deserializes into IntercomError', () => {
    const err1 = deserializeError('oops');
    expect(err1).toBeInstanceOf(IntercomError);
    expect(err1.message).toBe('oops');

    const err2 = deserializeError(['oops', ['y']]);
    expect(err2.errors).toEqual(['y']);
  });

  it('leaves the two old wire shapes decoding exactly as before', () => {
    // A bare string and a `[message, errors]` array are the only two shapes a pre-fix backend
    // ever sent. Neither carries `code` or a spending-limit payload - the new object shape below
    // is additive, so these two must keep decoding with nothing extra attached.
    const fromString = deserializeError('plain failure');
    expect(fromString.message).toBe('plain failure');
    expect(fromString.code).toBeUndefined();
    expect(fromString.assessment).toBeUndefined();
    expect(fromString.symbol).toBeUndefined();

    const fromArray = deserializeError(['plain failure', ['detail']]);
    expect(fromArray.message).toBe('plain failure');
    expect(fromArray.errors).toEqual(['detail']);
    expect(fromArray.code).toBeUndefined();
  });

  it('round-trips a breach assessment across the port, keeping code and the assessment readable', () => {
    const assessment: SpendingLimitAssessment = {
      accountId: 'account-a',
      usdAmount: 20n,
      revision: 'revision-1',
      assessedAt: 100,
      breach: { spent: 90n, proposedTotal: 110n, limit: 100n, overBy: 10n, resetAt: 200 }
    };
    const error = new SpendingLimitAuthorizationRequiredError(assessment);

    const restored = deserializeError(serializeError(error));

    expect(restored).toBeInstanceOf(IntercomError);
    expect(restored.code).toBe('SPENDING_LIMIT_AUTHORIZATION_REQUIRED');
    expect(spendingLimitAssessmentFromError(restored)).toEqual(assessment);
  });

  it('round-trips a price-unavailable refusal across the port, keeping code and the symbol readable', () => {
    const error = new SpendingLimitPriceUnavailableError('USDC');

    const restored = deserializeError(serializeError(error));

    expect(restored.code).toBe('SPENDING_LIMIT_PRICE_UNAVAILABLE');
    expect(isSpendingLimitPriceUnavailable(restored)).toBe(true);
  });

  it('produces a REAL Error, so callers can read the reason off it', () => {
    // Every consumer of a rejected intercom request narrows with
    // `e instanceof Error ? e.message : String(e)` (ForgotPassword.tsx:94 and
    // ~25 other sites). While IntercomError only `implements Error` — a
    // compile-time contract TypeScript erases — that test was false and the
    // fallback printed the literal "[object Object]" instead of the reason.
    // On the forgot-password route that string is the ONLY thing a user gets
    // after a failed recovery has already wiped their wallet (#630).
    const err = deserializeError('No Guardian accounts found for this seed');

    expect(err).toBeInstanceOf(Error);
    // The consumer expression itself, verbatim — this is what the screens run.
    expect(err instanceof Error ? err.message : String(err)).toBe('No Guardian accounts found for this seed');
  });

  it('strips spending-limit and code fields at the page boundary', () => {
    // The page-facing serializer must never leak code, assessment, or symbol to an untrusted
    // dApp, even when the error carries them. Build an error the realistic way: through
    // serializeError + deserializeError, so it carries the restored fields exactly as the
    // content script would receive it.
    const assessment: SpendingLimitAssessment = {
      accountId: 'account-a',
      usdAmount: 50n,
      revision: 'revision-1',
      assessedAt: 100,
      breach: { spent: 45n, proposedTotal: 55n, limit: 50n, overBy: 5n, resetAt: 200 }
    };
    const spendingLimitError = new SpendingLimitAuthorizationRequiredError(assessment);
    const restored = deserializeError(serializeError(spendingLimitError));

    // Confirm the restored error has code (the main field the page-facing serializer should strip).
    expect(restored.code).toBe('SPENDING_LIMIT_AUTHORIZATION_REQUIRED');

    // Pass through the page-facing serializer.
    const pageSerialized = serializeErrorForPage(restored);

    // Assert it contains ONLY the message, never code, assessment, or symbol.
    expect(pageSerialized).toBe(restored.message);
    expect(typeof pageSerialized).toBe('string');
    expect((pageSerialized as any).code).toBeUndefined();
    expect((pageSerialized as any).assessment).toBeUndefined();
    expect((pageSerialized as any).symbol).toBeUndefined();
  });

  it('preserves [message, errors] shape at the page boundary', () => {
    const error = { message: 'Operation failed', errors: ['detail-1', 'detail-2'] };

    const pageSerialized = serializeErrorForPage(error);

    expect(pageSerialized).toEqual(['Operation failed', ['detail-1', 'detail-2']]);
    expect((pageSerialized as any).code).toBeUndefined();
  });
});
