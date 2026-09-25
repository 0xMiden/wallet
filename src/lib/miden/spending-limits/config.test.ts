import { SendTransaction } from '../db/types';
import { spendingLimits, transactions } from '../repo';
import { NoteTypeEnum } from '../types';
import {
  SpendingLimitConfigurationConflictError,
  SpendingLimitDraft,
  SpendingLimitStrictAuthenticationRequiredError,
  classifySpendingLimitChange,
  readSpendingLimit,
  saveSpendingLimit
} from './config';
import { queueOutgoingTransaction, spendsOf } from './queue';
import { SpendingLimitAuthorizationRequiredError, SpendingLimitConfiguration } from './types';
import { resolveSpendsUsd } from './valuation';

jest.mock('./valuation', () => ({ resolveSpendsUsd: jest.fn() }));

const mockedResolve = jest.mocked(resolveSpendsUsd);

const NOW = 2_000_000;
const ACCOUNT = 'account-a';

const draft = (overrides: Partial<SpendingLimitDraft> = {}): SpendingLimitDraft => ({
  accountId: ACCOUNT,
  limit: 100n,
  ...overrides
});

const existing = (overrides: Partial<SpendingLimitConfiguration> = {}): SpendingLimitConfiguration => ({
  accountId: ACCOUNT,
  limit: 100n,
  revision: 'revision-1',
  createdAt: NOW - 100,
  updatedAt: NOW - 50,
  ...overrides
});

const save = (
  value: SpendingLimitDraft,
  observedRevision: string | undefined,
  strictlyAuthenticated: boolean,
  revision = 'revision-next'
) =>
  saveSpendingLimit(value, {
    observedRevision,
    strictlyAuthenticated,
    now: NOW,
    makeRevision: () => revision
  });

beforeEach(() => {
  jest.clearAllMocks();
  // A 1:1 passthrough: these tests exercise the config/queue interaction, not real dollar
  // valuation, which policy.test.ts and valuation.test.ts already cover at realistic magnitudes.
  mockedResolve.mockImplementation(async spends => spends.reduce((total, spend) => total + spend.amount, 0n));
});

describe('spending-limit configuration', () => {
  it('stores and reads one canonical account identity across composite and bare forms', async () => {
    await save(draft({ accountId: `${ACCOUNT}_route` }), undefined, true);

    await expect(readSpendingLimit(ACCOUNT)).resolves.toMatchObject({ accountId: ACCOUNT, limit: 100n });
    await expect(spendingLimits.get(`${ACCOUNT}_route`)).resolves.toBeUndefined();
    await expect(spendingLimits.get(ACCOUNT)).resolves.toBeDefined();
  });

  it('reads no configuration for an account with none', async () => {
    await expect(readSpendingLimit(ACCOUNT)).resolves.toBeUndefined();
  });

  it('requires strict authentication to create a limit', async () => {
    await expect(save(draft(), undefined, false)).rejects.toBeInstanceOf(
      SpendingLimitStrictAuthenticationRequiredError
    );
    await expect(spendingLimits.count()).resolves.toBe(0);

    await expect(save(draft(), undefined, true)).resolves.toMatchObject({ revision: 'revision-next' });
  });

  it.each([
    ['lowering the cap', draft({ limit: 90n })],
    ['keeping the limit unchanged', draft()]
  ])('allows %s without strict authentication', async (_label, next) => {
    await spendingLimits.put({
      accountId: ACCOUNT,
      limit: '100',
      revision: 'revision-1',
      createdAt: NOW - 100,
      updatedAt: NOW - 50
    });

    await expect(save(next, 'revision-1', false)).resolves.toMatchObject({ revision: 'revision-next' });
  });

  it('classifies a no-op draft against no configuration as safe', () => {
    expect(classifySpendingLimitChange(undefined, draft({ limit: undefined }))).toBe('safe');
  });

  it.each([
    ['adding a limit for the first time', undefined, draft()],
    ['raising the cap', existing(), draft({ limit: 101n })],
    ['disabling the record', existing(), draft({ limit: undefined })]
  ])('classifies %s as requiring strict authentication', (_label, current, next) => {
    expect(classifySpendingLimitChange(current, next)).toBe('strict-authentication');
  });

  it('does not write a weakening edit until strict authentication succeeds', async () => {
    await spendingLimits.put({
      accountId: ACCOUNT,
      limit: '100',
      revision: 'revision-1',
      createdAt: NOW - 100,
      updatedAt: NOW - 50
    });

    await expect(save(draft({ limit: 101n }), 'revision-1', false)).rejects.toBeInstanceOf(
      SpendingLimitStrictAuthenticationRequiredError
    );
    await expect(spendingLimits.get(ACCOUNT)).resolves.toMatchObject({ limit: '100', revision: 'revision-1' });
  });

  it('deletes the record when the limit is absent after strict authentication', async () => {
    await spendingLimits.put({
      accountId: ACCOUNT,
      limit: '100',
      revision: 'revision-1',
      createdAt: NOW - 100,
      updatedAt: NOW - 50
    });

    await expect(save(draft({ limit: undefined }), 'revision-1', true)).resolves.toBeUndefined();
    await expect(spendingLimits.get(ACCOUNT)).resolves.toBeUndefined();
  });

  it('validates a disabled draft before attempting deletion', async () => {
    await expect(save(draft({ accountId: '', limit: undefined }), undefined, false)).rejects.toThrow(
      /policy is unavailable/i
    );
  });

  it('rejects a stale observed revision and preserves the winner', async () => {
    await spendingLimits.put({
      accountId: ACCOUNT,
      limit: '100',
      revision: 'revision-current',
      createdAt: NOW - 100,
      updatedAt: NOW - 50
    });

    await expect(save(draft({ limit: 90n }), 'revision-old', false)).rejects.toBeInstanceOf(
      SpendingLimitConfigurationConflictError
    );
    await expect(spendingLimits.get(ACCOUNT)).resolves.toMatchObject({ limit: '100', revision: 'revision-current' });
  });

  it('regenerates the revision and preserves createdAt on every accepted edit', async () => {
    await spendingLimits.put({
      accountId: ACCOUNT,
      limit: '100',
      revision: 'revision-1',
      createdAt: NOW - 100,
      updatedAt: NOW - 50
    });

    await expect(save(draft({ limit: 90n }), 'revision-1', false, 'revision-2')).resolves.toEqual({
      accountId: ACCOUNT,
      limit: 90n,
      revision: 'revision-2',
      createdAt: NOW - 100,
      updatedAt: NOW
    });
  });

  it('serializes a limit raise against transaction queueing', async () => {
    await spendingLimits.put({
      accountId: ACCOUNT,
      limit: '50',
      revision: 'revision-1',
      createdAt: NOW - 100,
      updatedAt: NOW - 50
    });
    const transaction = new SendTransaction(ACCOUNT, 80n, 'account-b', 'faucet-a', NoteTypeEnum.Public);
    transaction.id = 'candidate';
    transaction.initiatedAt = NOW;

    const [saved, queued] = await Promise.allSettled([
      save(draft({ limit: 100n }), 'revision-1', true, 'revision-2'),
      queueOutgoingTransaction(transaction, spendsOf(transaction), undefined, NOW)
    ]);

    expect(saved.status).toBe('fulfilled');
    await expect(spendingLimits.get(ACCOUNT)).resolves.toMatchObject({ limit: '100', revision: 'revision-2' });

    // Enumerate the states serialization PERMITS, and let anything else fail. A torn interleaving
    // (a row admitted against the old 50 cap, or a rejection that still inserted) matches neither.
    const inserted = await transactions.get('candidate');
    const stored = await spendingLimits.get(ACCOUNT);
    expect([
      // The save committed first, so the queue assessed 80 against the raised cap and admitted it.
      { queued: 'fulfilled', spentUsd: 80n, limit: '100' },
      // The queue read the old 50 cap first, so 80 breached and nothing was written.
      { queued: 'rejected', spentUsd: undefined, limit: '100' }
    ]).toContainEqual({ queued: queued.status, spentUsd: inserted?.spentUsd, limit: stored?.limit });
  });

  it('admits a transaction the raised limit allows once the save has committed', async () => {
    await spendingLimits.put({
      accountId: ACCOUNT,
      limit: '50',
      revision: 'revision-1',
      createdAt: NOW - 100,
      updatedAt: NOW - 50
    });
    const transaction = new SendTransaction(ACCOUNT, 80n, 'account-b', 'faucet-a', NoteTypeEnum.Public);
    transaction.id = 'candidate';
    transaction.initiatedAt = NOW;

    // The deterministic half of the race above: 80 is over the old cap and under the new one, so
    // this can only pass if the queue re-reads the policy rather than caching the pre-save value.
    await save(draft({ limit: 100n }), 'revision-1', true, 'revision-2');
    await queueOutgoingTransaction(transaction, spendsOf(transaction), undefined, NOW);

    await expect(transactions.get('candidate')).resolves.toMatchObject({ spentUsd: 80n });
  });

  it('assesses a row under a cap created between the fast-path probe and the write lock', async () => {
    // The record already exists - representing a concurrent saveSpendingLimit that committed
    // between the fast-path probe and the write lock queueOutgoingTransaction takes to recheck it.
    // The FIRST `spendingLimits.get` call is faked to answer undefined so the probe still sees "no
    // cap", exactly as it would have if it had run a moment earlier; every later call sees the real
    // row, because it never stopped being there.
    await spendingLimits.put({
      accountId: ACCOUNT,
      limit: '50',
      revision: 'revision-1',
      createdAt: NOW,
      updatedAt: NOW
    });
    const read = jest.spyOn(spendingLimits, 'get').mockResolvedValueOnce(undefined);
    const transaction = new SendTransaction(ACCOUNT, 60n, 'account-b', 'faucet-a', NoteTypeEnum.Public);
    transaction.id = 'candidate';
    transaction.initiatedAt = NOW;

    try {
      // 60 breaches the 50 cap and no authorization was supplied, so a row that is genuinely
      // assessed must be refused - never admitted bare because the fast path won the race.
      await expect(queueOutgoingTransaction(transaction, spendsOf(transaction), undefined, NOW)).rejects.toBeInstanceOf(
        SpendingLimitAuthorizationRequiredError
      );
    } finally {
      read.mockRestore();
    }
    await expect(transactions.get('candidate')).resolves.toBeUndefined();
  });
});

describe('default clock and revision generator', () => {
  // `save()` in this file always injects both. Production supplies neither, so these two
  // fallbacks were the only part of saveSpendingLimit no test had ever run.
  it('stamps the wall clock and generates a revision when neither is supplied', async () => {
    const saved = await saveSpendingLimit(draft(), { observedRevision: undefined, strictlyAuthenticated: true });

    expect(saved?.updatedAt).toBeGreaterThan(1_700_000_000);
    expect(saved?.createdAt).toBe(saved?.updatedAt);
    // A uuid, not the fixture's 'revision-next'.
    expect(saved?.revision).toMatch(/^[0-9a-f-]{36}$/);
  });
});
