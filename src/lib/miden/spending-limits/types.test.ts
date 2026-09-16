import {
  SpendingLimitPolicyUnavailableError,
  parsePersistedSpendingLimit,
  parseSpendingLimitAssessment,
  parseSerializedSpendingAmount,
  parseSerializedSpendingLimitAssessment,
  parseSerializedSpendingLimitDraft,
  spendingLimitAssessmentFromError,
  toPersistedSpendingLimit,
  toSerializedSpendingLimitAssessment,
  toSerializedSpendingLimitDraft
} from './types';

describe('spending-limit persistence types', () => {
  const configured = {
    accountId: 'account-a',
    faucetId: 'faucet-a',
    dailyLimit: 123456789012345678901234567890n,
    weeklyLimit: 999999999999999999999999999999n,
    asset: { symbol: 'MIDEN', decimals: 8, name: 'Miden' },
    revision: 'revision-1',
    createdAt: 100,
    updatedAt: 200
  };

  it('round-trips limits through canonical decimal strings without losing bigint precision', () => {
    const persisted = toPersistedSpendingLimit(configured);

    expect(persisted).toEqual({
      ...configured,
      dailyLimit: '123456789012345678901234567890',
      weeklyLimit: '999999999999999999999999999999'
    });
    expect(parsePersistedSpendingLimit(persisted)).toEqual(configured);
  });

  it('returns no record when neither rolling period is configured', () => {
    expect(toPersistedSpendingLimit({ ...configured, dailyLimit: undefined, weeklyLimit: undefined })).toBeUndefined();
  });

  it.each([
    ['negative daily domain amount', { ...configured, dailyLimit: -1n }],
    ['negative weekly domain amount', { ...configured, weeklyLimit: -1n }],
    ['missing account id', { ...configured, accountId: '' }],
    ['missing faucet id', { ...configured, faucetId: '' }],
    ['missing revision', { ...configured, revision: '' }],
    ['invalid decimals', { ...configured, asset: { symbol: 'MIDEN', decimals: -1 } }],
    ['excessive decimals', { ...configured, asset: { symbol: 'MIDEN', decimals: 256 } }],
    ['fractional decimals', { ...configured, asset: { symbol: 'MIDEN', decimals: 1.5 } }],
    ['non-number decimals', { ...configured, asset: { symbol: 'MIDEN', decimals: '8' } }],
    ['invalid asset name', { ...configured, asset: { symbol: 'MIDEN', decimals: 8, name: ' ' } }],
    ['negative timestamp', { ...configured, createdAt: -1 }],
    ['fractional timestamp', { ...configured, createdAt: 1.5 }],
    ['invalid timestamp order', { ...configured, createdAt: 201, updatedAt: 200 }]
  ])('rejects %s', (_label, value) => {
    expect(() => toPersistedSpendingLimit(value as Parameters<typeof toPersistedSpendingLimit>[0])).toThrow(
      SpendingLimitPolicyUnavailableError
    );
  });

  it.each([
    ['non-canonical leading zero', { ...configured, dailyLimit: '01', weeklyLimit: undefined }],
    ['negative persisted amount', { ...configured, dailyLimit: '-1', weeklyLimit: undefined }],
    ['missing periods', { ...configured, dailyLimit: undefined, weeklyLimit: undefined }],
    ['number instead of decimal string', { ...configured, dailyLimit: 1, weeklyLimit: undefined }],
    ['missing asset snapshot', { ...configured, dailyLimit: '1', weeklyLimit: undefined, asset: undefined }],
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

  it('round-trips transport drafts with optional periods and asset names', () => {
    const draft = {
      accountId: 'account-a',
      faucetId: 'faucet-a',
      asset: { symbol: 'MIDEN', decimals: 8 },
      dailyLimit: undefined,
      weeklyLimit: 250n
    };

    const serialized = toSerializedSpendingLimitDraft(draft);

    expect(serialized).toEqual({
      accountId: 'account-a',
      faucetId: 'faucet-a',
      asset: { symbol: 'MIDEN', decimals: 8 },
      weeklyLimit: '250'
    });
    expect(parseSerializedSpendingLimitDraft(serialized)).toEqual(draft);
    expect(() => parseSerializedSpendingLimitDraft(null)).toThrow(SpendingLimitPolicyUnavailableError);
  });

  it('round-trips a structured assessment without bigint transport values', () => {
    const assessment = {
      accountId: 'account-a',
      faucetId: 'faucet-a',
      amount: 20n,
      revision: 'revision-1',
      assessedAt: 100,
      breaches: [
        {
          period: '24h' as const,
          spent: 90n,
          proposedTotal: 110n,
          limit: 100n,
          overBy: 10n,
          resetAt: 200
        }
      ]
    };

    const serialized = toSerializedSpendingLimitAssessment(assessment);

    expect(serialized).toEqual({
      ...assessment,
      amount: '20',
      breaches: [
        {
          period: '24h',
          spent: '90',
          proposedTotal: '110',
          limit: '100',
          overBy: '10',
          resetAt: 200
        }
      ]
    });
    expect(parseSerializedSpendingLimitAssessment(serialized)).toEqual(assessment);
    expect(parseSpendingLimitAssessment(assessment)).toEqual(assessment);
    expect(spendingLimitAssessmentFromError({ code: 'SPENDING_LIMIT_AUTHORIZATION_REQUIRED', assessment })).toEqual(
      assessment
    );
  });

  it.each([
    ['non-canonical amount', { amount: '020' }],
    ['invalid period', { breaches: [{ period: 'month' }] }],
    ['negative overage', { breaches: [{ overBy: '-1' }] }],
    ['inconsistent overage', { breaches: [{ overBy: '9' }] }],
    ['inconsistent proposed total', { breaches: [{ proposedTotal: '109' }] }],
    ['non-integer reset', { breaches: [{ resetAt: 1.5 }] }]
  ] as Array<[string, { amount?: string; breaches?: Array<Record<string, unknown>> }]>)(
    'rejects a malformed serialized assessment with %s',
    (_label, overrides) => {
      const valid = {
        accountId: 'account-a',
        faucetId: 'faucet-a',
        amount: '20',
        revision: 'revision-1',
        assessedAt: 100,
        breaches: [
          {
            period: '24h',
            spent: '90',
            proposedTotal: '110',
            limit: '100',
            overBy: '10',
            resetAt: 200
          }
        ]
      };
      const value = {
        ...valid,
        ...overrides,
        ...(overrides.breaches && { breaches: [{ ...valid.breaches[0], ...overrides.breaches[0] }] })
      };

      expect(() => parseSerializedSpendingLimitAssessment(value)).toThrow(SpendingLimitPolicyUnavailableError);
    }
  );

  it('rejects malformed domain assessments and unrelated errors', () => {
    const malformed = {
      accountId: 'account-a',
      faucetId: 'faucet-a',
      amount: -1n,
      revision: 'revision-1',
      assessedAt: 100,
      breaches: []
    };

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
    ['non-array breaches', { breaches: null }],
    ['missing amount', { amount: undefined }],
    [
      'too many breach periods',
      {
        breaches: [
          { period: '24h', spent: 90n, proposedTotal: 110n, limit: 100n, overBy: 10n, resetAt: 200 },
          { period: '7d', spent: 240n, proposedTotal: 260n, limit: 250n, overBy: 10n, resetAt: 200 },
          { period: '24h', spent: 90n, proposedTotal: 110n, limit: 100n, overBy: 10n, resetAt: 200 }
        ]
      }
    ],
    [
      'duplicate breach periods',
      {
        breaches: [
          { period: '24h', spent: 90n, proposedTotal: 110n, limit: 100n, overBy: 10n, resetAt: 200 },
          { period: '24h', spent: 90n, proposedTotal: 110n, limit: 100n, overBy: 10n, resetAt: 200 }
        ]
      }
    ],
    [
      'non-breaching total',
      { breaches: [{ period: '24h', spent: 80n, proposedTotal: 100n, limit: 100n, overBy: 0n, resetAt: 200 }] }
    ],
    [
      'expired reset',
      { breaches: [{ period: '24h', spent: 90n, proposedTotal: 110n, limit: 100n, overBy: 10n, resetAt: 100 }] }
    ],
    [
      'out-of-order breach periods',
      {
        breaches: [
          { period: '7d', spent: 240n, proposedTotal: 260n, limit: 250n, overBy: 10n, resetAt: 200 },
          { period: '24h', spent: 90n, proposedTotal: 110n, limit: 100n, overBy: 10n, resetAt: 200 }
        ]
      }
    ]
  ] as Array<[string, unknown]>)('rejects a domain assessment with %s', (_label, overrides) => {
    const valid = {
      accountId: 'account-a',
      faucetId: 'faucet-a',
      amount: 20n,
      revision: 'revision-1',
      assessedAt: 100,
      breaches: [{ period: '24h', spent: 90n, proposedTotal: 110n, limit: 100n, overBy: 10n, resetAt: 200 }]
    };
    const value =
      overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? { ...valid, ...overrides } : overrides;

    expect(() => parseSpendingLimitAssessment(value)).toThrow(SpendingLimitPolicyUnavailableError);
  });

  it.each([
    ['non-record assessment', null],
    ['non-array breaches', { breaches: null }],
    ['missing amount', { amount: undefined }]
  ] as Array<[string, unknown]>)('rejects a serialized assessment with %s', (_label, overrides) => {
    const valid = {
      accountId: 'account-a',
      faucetId: 'faucet-a',
      amount: '20',
      revision: 'revision-1',
      assessedAt: 100,
      breaches: [{ period: '24h', spent: '90', proposedTotal: '110', limit: '100', overBy: '10', resetAt: 200 }]
    };
    const value = overrides && typeof overrides === 'object' ? { ...valid, ...overrides } : overrides;

    expect(() => parseSerializedSpendingLimitAssessment(value)).toThrow(SpendingLimitPolicyUnavailableError);
  });
});
