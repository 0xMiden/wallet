import fs from 'fs';
import path from 'path';

import {
  WasmClientPoisonedError,
  isSyncWatchdogEviction,
  isWasmClientPoisonedError
} from 'lib/miden/sdk/wasm-client-poison';
import {
  isSpendingLimitPriceUnavailable,
  spendingLimitAssessmentFromError,
  SpendingLimitAuthorizationRequiredError,
  SpendingLimitPriceUnavailableError,
  type SpendingLimitAssessment
} from 'lib/miden/spending-limits/types';

import {
  DEFAULT_ERROR_MESSAGE,
  deserializeError,
  deserializeInternalError,
  IntercomError,
  serializeError,
  serializeErrorForPage,
  serializeInternalError
} from './helpers';

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

  describe('the wallet-internal envelope', () => {
    // Both classifiers, on the rebuilt error, because they read DIFFERENT fields
    // and the difference is the whole reason the envelope grew: the name decides
    // whether the pass stops taking holds, the reason decides whether the node is
    // recorded as parked. Carrying only the name left the second one
    // unconditionally false for every error that crossed this port, so a backend
    // eviction could not feed the sync fuse at all.
    it.each([
      ['watchdog', true],
      ['realm-error', false]
    ] as const)('carries a %s eviction so both classifiers still answer', (reason, parked) => {
      const original = new WasmClientPoisonedError(reason);
      const revived = deserializeInternalError(serializeInternalError(original));

      expect(isWasmClientPoisonedError(revived)).toBe(true);
      expect(isSyncWatchdogEviction(revived)).toBe(parked);
      expect(revived.message).toBe(original.message);
    });

    // An ARRAY, tested as an array: an object envelope round-trips just as well
    // through the current pair and fails only against the OLD deserializer,
    // which is the one hop this shape exists to survive.
    it('degrades to message and errors under the previous deserializer', () => {
      const wire = serializeInternalError(new WasmClientPoisonedError('watchdog'));
      const legacy = deserializeError(wire);

      expect(legacy.message).toBe(new WasmClientPoisonedError('watchdog').message);
      expect(legacy.message).not.toContain('[object Object]');
    });

    // The other direction of the same skew - a client updated ahead of its
    // server - which turns every backend error into the default message if the
    // shorter legacy array is not recognised.
    it('reads the legacy two-element array from an older server', () => {
      const revived = deserializeInternalError(['bad', ['x']]);

      expect(revived.message).toBe('bad');
      expect(revived.errors).toEqual(['x']);
      expect(isWasmClientPoisonedError(revived)).toBe(false);
    });

    it('falls back to the default message when the envelope carries no string', () => {
      expect(deserializeInternalError([undefined, undefined, undefined, undefined]).message).toBe(
        DEFAULT_ERROR_MESSAGE
      );
      expect(serializeInternalError(undefined)[0]).toBe(DEFAULT_ERROR_MESSAGE);
    });

    // The spending-limit refusals cross THIS port, not the page one, so the envelope has to
    // carry their code and payload; dropping them leaves the send screen unable to tell a
    // breach from an unpriceable asset.
    it('carries a breach assessment, keeping code and the assessment readable', () => {
      const assessment: SpendingLimitAssessment = {
        accountId: 'account-a',
        usdAmount: 20n,
        revision: 'revision-1',
        assessedAt: 100,
        breach: { spent: 90n, proposedTotal: 110n, limit: 100n, overBy: 10n, resetAt: 200 }
      };
      const original = new SpendingLimitAuthorizationRequiredError(assessment);
      const revived = deserializeInternalError(serializeInternalError(original));

      expect(revived.code).toBe('SPENDING_LIMIT_AUTHORIZATION_REQUIRED');
      expect(spendingLimitAssessmentFromError(revived)).toEqual(assessment);
      expect(revived.message).toBe(original.message);
    });

    it('carries a price-unavailable refusal, keeping code and the symbol readable', () => {
      const revived = deserializeInternalError(serializeInternalError(new SpendingLimitPriceUnavailableError('USDC')));

      expect(revived.code).toBe('SPENDING_LIMIT_PRICE_UNAVAILABLE');
      expect(revived.symbol).toBe('USDC');
      expect(isSpendingLimitPriceUnavailable(revived)).toBe(true);
    });

    // A 1.16.2 service worker under an open port still speaks `serializeError`, whose
    // spending-limit refusals are an object.
    it('reads the object shape a 1.16.2 server sends for a spending-limit refusal', () => {
      const revived = deserializeInternalError(serializeError(new SpendingLimitPriceUnavailableError('USDC')));

      expect(revived.code).toBe('SPENDING_LIMIT_PRICE_UNAVAILABLE');
      expect(isSpendingLimitPriceUnavailable(revived)).toBe(true);
    });

    // An ordinary error must not come back looking evicted - the classifiers are
    // only useful if they can say no.
    it('leaves an ordinary error unclassified', () => {
      const revived = deserializeInternalError(serializeInternalError(new Error('boom')));

      expect(revived.message).toBe('boom');
      expect(isWasmClientPoisonedError(revived)).toBe(false);
      expect(isSyncWatchdogEviction(revived)).toBe(false);
    });
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

  it('carries the errors array alongside code in the internal object wire shape', () => {
    // Every existing object-shape case here has a `code`/spending-limit payload but no `errors`
    // array, so the `errors` key of the returned object has never actually been populated - only
    // ever omitted. An error that legitimately carries both must keep both, not drop one for the
    // other.
    const error = { message: 'Operation failed', code: 'SOME_CODE', errors: ['detail-1', 'detail-2'] };

    expect(serializeError(error)).toEqual({
      message: 'Operation failed',
      errors: ['detail-1', 'detail-2'],
      code: 'SOME_CODE'
    });
  });
});

describe('helpers.ts stays free of the SDK', () => {
  // This file is bundled into the extension content script (see the file-level comment in
  // helpers.ts). A runtime import reaching lib/miden or @miden-sdk drags the WASM SDK into
  // that bundle and breaks window.midenWallet injection on every page. `import type` is
  // erased at build and is safe; only a value import is a regression.
  const source = fs.readFileSync(path.join(__dirname, 'helpers.ts'), 'utf8');

  it('has no runtime import from lib/miden or @miden-sdk', () => {
    const importRe = /import\s+(type\s+)?[^;]*?from\s+['"]([^'"]+)['"]/g;
    const offenders: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = importRe.exec(source)) !== null) {
      const [statement, isTypeOnly, specifier] = match;
      const reachesSdk = (specifier ?? '').startsWith('lib/miden') || (specifier ?? '').startsWith('@miden-sdk');
      if (reachesSdk && !isTypeOnly) offenders.push(statement.replace(/\s+/g, ' ').trim());
    }

    expect(offenders).toEqual([]);
  });
});
