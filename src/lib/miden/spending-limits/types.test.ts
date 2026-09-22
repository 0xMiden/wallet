import {
  SpendingLimitPolicyUnavailableError,
  parsePersistedSpendingLimit,
  parseSpendingLimitAssessment,
  parseSerializedSpendingAmount,
  parseSerializedSpendingLimitAssessment,
  parseSerializedSpendingLimitDraft,
  spendingLimitAssessmentFromError,
  spendsDigest,
  toPersistedSpendingLimit,
  toSerializedSpendingLimitAssessment,
  toSerializedSpendingLimitDraft
} from './types';

describe('spending-limit persistence types', () => {
  const configured = {
    accountId: 'account-a',
    limit: 123456789012345678901234567890n,
    revision: 'revision-1',
    createdAt: 100,
    updatedAt: 200
  };

  it('round-trips a limit through a canonical decimal string without losing bigint precision', () => {
    const persisted = toPersistedSpendingLimit(configured);

    expect(persisted).toEqual({ ...configured, limit: '123456789012345678901234567890' });
    expect(parsePersistedSpendingLimit(persisted)).toEqual(configured);
  });

  it.each([
    ['negative domain limit', { ...configured, limit: -1n }],
    ['missing account id', { ...configured, accountId: '' }],
    ['missing revision', { ...configured, revision: '' }],
    ['negative timestamp', { ...configured, createdAt: -1 }],
    ['fractional timestamp', { ...configured, createdAt: 1.5 }],
    ['invalid timestamp order', { ...configured, createdAt: 201, updatedAt: 200 }]
  ])('rejects %s', (_label, value) => {
    expect(() => toPersistedSpendingLimit(value as Parameters<typeof toPersistedSpendingLimit>[0])).toThrow(
      SpendingLimitPolicyUnavailableError
    );
  });

  it.each([
    ['non-canonical leading zero', { ...configured, limit: '01' }],
    ['negative persisted amount', { ...configured, limit: '-1' }],
    ['missing limit', { ...configured, limit: undefined }],
    ['number instead of decimal string', { ...configured, limit: 1 }],
    ['array record', []],
    ['malformed record', null]
  ])('rejects %s', (_label, value) => {
    expect(() => parsePersistedSpendingLimit(value)).toThrow(SpendingLimitPolicyUnavailableError);
  });

  it('defines a stable unavailable-policy error code', () => {
    const error = new SpendingLimitPolicyUnavailableError('broken policy');

    expect(error.name).toBe('SpendingLimitPolicyUnavailableError');
    expect(error.code).toBe('SPENDING_LIMIT_POLICY_UNAVAILABLE');
    expect(error.message).toBe('broken policy');
  });

  it('parses a canonical serialized proposal amount', () => {
    expect(parseSerializedSpendingAmount('12345678901234567890')).toBe(12345678901234567890n);
    expect(() => parseSerializedSpendingAmount('01')).toThrow(SpendingLimitPolicyUnavailableError);
  });

  it('round-trips transport drafts with an optional limit', () => {
    const draft = { accountId: 'account-a', limit: 250n };

    const serialized = toSerializedSpendingLimitDraft(draft);

    expect(serialized).toEqual({ accountId: 'account-a', limit: '250' });
    expect(parseSerializedSpendingLimitDraft(serialized)).toEqual(draft);
    expect(() => parseSerializedSpendingLimitDraft(null)).toThrow(SpendingLimitPolicyUnavailableError);
  });

  it('round-trips a draft with no limit at all', () => {
    const draft = { accountId: 'account-a' };

    const serialized = toSerializedSpendingLimitDraft(draft);

    expect(serialized).toEqual({ accountId: 'account-a' });
    expect(parseSerializedSpendingLimitDraft(serialized)).toEqual(draft);
  });

  it('round-trips a structured assessment with a breach', () => {
    const assessment = {
      accountId: 'account-a',
      usdAmount: 20n,
      revision: 'revision-1',
      assessedAt: 100,
      breach: { spent: 90n, proposedTotal: 110n, limit: 100n, overBy: 10n, resetAt: 200 }
    };

    const serialized = toSerializedSpendingLimitAssessment(assessment);

    expect(serialized).toEqual({
      ...assessment,
      usdAmount: '20',
      breach: { spent: '90', proposedTotal: '110', limit: '100', overBy: '10', resetAt: 200 }
    });
    expect(parseSerializedSpendingLimitAssessment(serialized)).toEqual(assessment);
    expect(parseSpendingLimitAssessment(assessment)).toEqual(assessment);
    expect(spendingLimitAssessmentFromError({ code: 'SPENDING_LIMIT_AUTHORIZATION_REQUIRED', assessment })).toEqual(
      assessment
    );
    // The domain form (bigints) is what an in-process rethrow (mobile/desktop) carries; the
    // serialized form (decimal strings) is what survives an intercom port crossing on the
    // extension. Both must resolve to the same assessment.
    expect(
      spendingLimitAssessmentFromError({ code: 'SPENDING_LIMIT_AUTHORIZATION_REQUIRED', assessment: serialized })
    ).toEqual(assessment);
  });

  it('round-trips an assessment with no breach at all', () => {
    const assessment = { accountId: 'account-a', usdAmount: 20n, revision: 'revision-1', assessedAt: 100 };

    const serialized = toSerializedSpendingLimitAssessment(assessment);

    expect(serialized).toEqual({ ...assessment, usdAmount: '20' });
    expect(parseSerializedSpendingLimitAssessment(serialized)).toEqual(assessment);
    expect(parseSpendingLimitAssessment(assessment)).toEqual(assessment);
  });

  it.each([
    ['non-canonical amount', { usdAmount: '020' }],
    ['negative overage', { breach: { overBy: '-1' } }],
    ['inconsistent overage', { breach: { overBy: '9' } }],
    ['inconsistent proposed total', { breach: { proposedTotal: '109' } }],
    ['non-integer reset', { breach: { resetAt: 1.5 } }]
  ] as Array<[string, { usdAmount?: string; breach?: Record<string, unknown> }]>)(
    'rejects a malformed serialized assessment with %s',
    (_label, overrides) => {
      const valid = {
        accountId: 'account-a',
        usdAmount: '20',
        revision: 'revision-1',
        assessedAt: 100,
        breach: { spent: '90', proposedTotal: '110', limit: '100', overBy: '10', resetAt: 200 }
      };
      const value = {
        ...valid,
        ...overrides,
        ...(overrides.breach && { breach: { ...valid.breach, ...overrides.breach } })
      };

      expect(() => parseSerializedSpendingLimitAssessment(value)).toThrow(SpendingLimitPolicyUnavailableError);
    }
  );

  it('rejects malformed domain assessments and unrelated errors', () => {
    const malformed = { accountId: 'account-a', usdAmount: -1n, revision: 'revision-1', assessedAt: 100 };

    expect(() => parseSpendingLimitAssessment(malformed)).toThrow(SpendingLimitPolicyUnavailableError);
    expect(spendingLimitAssessmentFromError({ code: 'SOMETHING_ELSE', assessment: malformed })).toBeUndefined();
    expect(spendingLimitAssessmentFromError(null)).toBeUndefined();
    expect(
      spendingLimitAssessmentFromError({ code: 'SPENDING_LIMIT_AUTHORIZATION_REQUIRED', assessment: malformed })
    ).toBeUndefined();
  });

  it.each([
    ['non-record assessment', null],
    ['array assessment', []],
    ['missing usdAmount', { usdAmount: undefined }],
    ['non-breaching total', { breach: { spent: 80n, proposedTotal: 100n, limit: 100n, overBy: 0n, resetAt: 200 } }],
    ['expired reset', { breach: { spent: 90n, proposedTotal: 110n, limit: 100n, overBy: 10n, resetAt: 100 } }]
  ] as Array<[string, unknown]>)('rejects a domain assessment with %s', (_label, overrides) => {
    const valid = {
      accountId: 'account-a',
      usdAmount: 20n,
      revision: 'revision-1',
      assessedAt: 100,
      breach: { spent: 90n, proposedTotal: 110n, limit: 100n, overBy: 10n, resetAt: 200 }
    };
    const value =
      overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? { ...valid, ...overrides } : overrides;

    expect(() => parseSpendingLimitAssessment(value)).toThrow(SpendingLimitPolicyUnavailableError);
  });

  it.each([
    ['non-record assessment', null],
    ['missing usdAmount', { usdAmount: undefined }]
  ] as Array<[string, unknown]>)('rejects a serialized assessment with %s', (_label, overrides) => {
    const valid = {
      accountId: 'account-a',
      usdAmount: '20',
      revision: 'revision-1',
      assessedAt: 100,
      breach: { spent: '90', proposedTotal: '110', limit: '100', overBy: '10', resetAt: 200 }
    };
    const value = overrides && typeof overrides === 'object' ? { ...valid, ...overrides } : overrides;

    expect(() => parseSerializedSpendingLimitAssessment(value)).toThrow(SpendingLimitPolicyUnavailableError);
  });
});

describe('breach parsing edges', () => {
  // Both arrive from the intercom boundary, where the shape is whatever the other realm sent.
  it('refuses a breach that is not an object at all', () => {
    expect(() =>
      parseSerializedSpendingLimitAssessment({
        accountId: 'account-a',
        usdAmount: '20',
        revision: 'revision-1',
        assessedAt: 1_000,
        breach: 'not-a-breach'
      })
    ).toThrow(/breach is invalid/i);
  });

  it('accepts a breach whose reset time is genuinely absent', () => {
    // `resetAt: null` is the real shape when the proposed amount alone exceeds the cap, so no
    // amount of waiting frees capacity. Only the non-null arm had a test.
    const parsed = parseSerializedSpendingLimitAssessment({
      accountId: 'account-a',
      usdAmount: '120',
      revision: 'revision-1',
      assessedAt: 1_000,
      breach: { spent: '0', proposedTotal: '120', limit: '100', overBy: '20', resetAt: null }
    });

    expect(parsed.breach?.resetAt).toBeNull();
  });
});

describe('spendsDigest', () => {
  it('is order-independent over the same spends', () => {
    const left = spendsDigest([
      { faucetId: 'eth', amount: 1n },
      { faucetId: 'usdc', amount: 2n }
    ]);
    const right = spendsDigest([
      { faucetId: 'usdc', amount: 2n },
      { faucetId: 'eth', amount: 1n }
    ]);

    expect(left).toBe(right);
  });

  it('differs when an amount differs', () => {
    const left = spendsDigest([{ faucetId: 'eth', amount: 1n }]);
    const right = spendsDigest([{ faucetId: 'eth', amount: 2n }]);

    expect(left).not.toBe(right);
  });

  it('differs when a faucet differs', () => {
    const left = spendsDigest([{ faucetId: 'eth', amount: 1n }]);
    const right = spendsDigest([{ faucetId: 'usdc', amount: 1n }]);

    expect(left).not.toBe(right);
  });

  it('matches equivalent faucet identities spelled differently', () => {
    const left = spendsDigest([{ faucetId: 'account-a', amount: 1n }]);
    const right = spendsDigest([{ faucetId: 'account-a_route', amount: 1n }]);

    expect(left).toBe(right);
  });
});
