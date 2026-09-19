import { SendTransaction } from '../db/types';
import { spendingLimits, transactions } from '../repo';
import { NoteTypeEnum } from '../types';
import {
  SpendingLimitConfigurationConflictError,
  SpendingLimitDraft,
  SpendingLimitStrictAuthenticationRequiredError,
  classifySpendingLimitChange,
  listSpendingLimits,
  saveSpendingLimit
} from './config';
import { queueOutgoingTransaction } from './queue';
import { SpendingLimitConfiguration } from './types';

const NOW = 2_000_000;

const draft = (overrides: Partial<SpendingLimitDraft> = {}): SpendingLimitDraft => ({
  accountId: 'account-a',
  faucetId: 'faucet-a',
  dailyLimit: 100n,
  weeklyLimit: 500n,
  asset: { symbol: 'MIDEN', decimals: 8 },
  ...overrides
});

const existing = (overrides: Partial<SpendingLimitConfiguration> = {}): SpendingLimitConfiguration => ({
  ...draft(),
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

describe('spending-limit configuration', () => {
  it('stores and lists one canonical account identity across composite and bare forms', async () => {
    await save(draft({ accountId: 'account-a_route' }), undefined, true);

    await expect(listSpendingLimits('account-a')).resolves.toEqual([
      expect.objectContaining({ accountId: 'account-a', faucetId: 'faucet-a' })
    ]);
    await expect(spendingLimits.get(['account-a_route', 'faucet-a'])).resolves.toBeUndefined();
    await expect(spendingLimits.get(['account-a', 'faucet-a'])).resolves.toBeDefined();
  });

  it('lists validated configurations only for the requested account', async () => {
    await spendingLimits.bulkPut([
      {
        ...draft(),
        dailyLimit: '100',
        weeklyLimit: '500',
        revision: 'revision-a',
        createdAt: 1,
        updatedAt: 1
      },
      {
        ...draft({ accountId: 'account-b', faucetId: 'faucet-b' }),
        dailyLimit: '200',
        weeklyLimit: '600',
        revision: 'revision-b',
        createdAt: 2,
        updatedAt: 2
      }
    ]);

    await expect(listSpendingLimits('account-a')).resolves.toEqual([
      expect.objectContaining({ accountId: 'account-a', faucetId: 'faucet-a', dailyLimit: 100n })
    ]);
  });

  it('requires strict authentication to create a limit', async () => {
    await expect(save(draft(), undefined, false)).rejects.toBeInstanceOf(
      SpendingLimitStrictAuthenticationRequiredError
    );
    await expect(spendingLimits.count()).resolves.toBe(0);

    await expect(save(draft(), undefined, true)).resolves.toMatchObject({ revision: 'revision-next' });
  });

  it.each([
    ['lowering one cap', draft({ dailyLimit: 90n })],
    ['lowering both caps', draft({ dailyLimit: 90n, weeklyLimit: 400n })],
    ['refreshing metadata', draft({ asset: { symbol: 'MIDEN', decimals: 8, name: 'Miden' } })],
    ['keeping limits unchanged', draft()]
  ])('allows %s without strict authentication', async (_label, next) => {
    await spendingLimits.put({
      ...draft(),
      dailyLimit: '100',
      weeklyLimit: '500',
      revision: 'revision-1',
      createdAt: NOW - 100,
      updatedAt: NOW - 50
    });

    await expect(save(next, 'revision-1', false)).resolves.toMatchObject({ revision: 'revision-next' });
  });

  it.each([
    ['adding the first period', undefined, draft({ weeklyLimit: undefined })],
    ['adding another period', existing({ weeklyLimit: undefined }), draft()],
    ['raising a cap', existing(), draft({ dailyLimit: 101n })],
    ['removing a period', existing(), draft({ weeklyLimit: undefined })],
    ['disabling the record', existing(), draft({ dailyLimit: undefined, weeklyLimit: undefined })],
    ['mixing a lower and a raise', existing(), draft({ dailyLimit: 90n, weeklyLimit: 501n })]
  ])('classifies %s as requiring strict authentication', (_label, current, next) => {
    expect(classifySpendingLimitChange(current, next)).toBe('strict-authentication');
  });

  it('does not write a weakening edit until strict authentication succeeds', async () => {
    await spendingLimits.put({
      ...draft(),
      dailyLimit: '100',
      weeklyLimit: '500',
      revision: 'revision-1',
      createdAt: NOW - 100,
      updatedAt: NOW - 50
    });

    await expect(save(draft({ dailyLimit: 101n }), 'revision-1', false)).rejects.toBeInstanceOf(
      SpendingLimitStrictAuthenticationRequiredError
    );
    await expect(spendingLimits.get(['account-a', 'faucet-a'])).resolves.toMatchObject({
      dailyLimit: '100',
      revision: 'revision-1'
    });
  });

  it('deletes the record when both periods are absent after strict authentication', async () => {
    await spendingLimits.put({
      ...draft(),
      dailyLimit: '100',
      weeklyLimit: '500',
      revision: 'revision-1',
      createdAt: NOW - 100,
      updatedAt: NOW - 50
    });

    await expect(
      save(draft({ dailyLimit: undefined, weeklyLimit: undefined }), 'revision-1', true)
    ).resolves.toBeUndefined();
    await expect(spendingLimits.get(['account-a', 'faucet-a'])).resolves.toBeUndefined();
  });

  it('validates a disabled draft before attempting deletion', async () => {
    await expect(
      save(draft({ accountId: '', dailyLimit: undefined, weeklyLimit: undefined }), undefined, false)
    ).rejects.toThrow(/policy is unavailable/i);
  });

  it('rejects a stale observed revision and preserves the winner', async () => {
    await spendingLimits.put({
      ...draft(),
      dailyLimit: '100',
      weeklyLimit: '500',
      revision: 'revision-current',
      createdAt: NOW - 100,
      updatedAt: NOW - 50
    });

    await expect(save(draft({ dailyLimit: 90n }), 'revision-old', false)).rejects.toBeInstanceOf(
      SpendingLimitConfigurationConflictError
    );
    await expect(spendingLimits.get(['account-a', 'faucet-a'])).resolves.toMatchObject({
      dailyLimit: '100',
      revision: 'revision-current'
    });
  });

  it('regenerates the revision and preserves createdAt on every accepted edit', async () => {
    await spendingLimits.put({
      ...draft(),
      dailyLimit: '100',
      weeklyLimit: '500',
      revision: 'revision-1',
      createdAt: NOW - 100,
      updatedAt: NOW - 50
    });

    await expect(save(draft({ dailyLimit: 90n }), 'revision-1', false, 'revision-2')).resolves.toEqual({
      ...draft({ dailyLimit: 90n }),
      revision: 'revision-2',
      createdAt: NOW - 100,
      updatedAt: NOW
    });
  });

  it('serializes a limit raise against transaction queueing', async () => {
    await spendingLimits.put({
      accountId: 'account-a',
      faucetId: 'faucet-a',
      dailyLimit: '50',
      asset: { symbol: 'MIDEN', decimals: 8 },
      revision: 'revision-1',
      createdAt: NOW - 100,
      updatedAt: NOW - 50
    });
    const transaction = new SendTransaction('account-a', 80n, 'account-b', 'faucet-a', NoteTypeEnum.Public);
    transaction.id = 'candidate';
    transaction.initiatedAt = NOW;

    const [saved, queued] = await Promise.allSettled([
      save(draft({ dailyLimit: 100n, weeklyLimit: undefined }), 'revision-1', true, 'revision-2'),
      queueOutgoingTransaction(transaction, undefined, NOW)
    ]);

    expect(saved.status).toBe('fulfilled');
    await expect(spendingLimits.get(['account-a', 'faucet-a'])).resolves.toMatchObject({
      dailyLimit: '100',
      revision: 'revision-2'
    });

    // Enumerate the states serialization PERMITS, and let anything else fail. The previous
    // assertions here - `queued.status === 'fulfilled'` equals `inserted !== undefined`, and an
    // expected amount computed from `inserted` itself - held under either ordering AND under no
    // ordering at all, so removing the rw transaction from saveSpendingLimit left them green.
    // A torn interleaving (a row admitted against the old 50 cap, or a rejection that still
    // inserted) matches neither row below.
    const inserted = await transactions.get('candidate');
    const stored = await spendingLimits.get(['account-a', 'faucet-a']);
    expect([
      // The save committed first, so the queue assessed 80 against the raised cap and admitted it.
      { queued: 'fulfilled', amount: 80n, dailyLimit: '100' },
      // The queue read the old 50 cap first, so 80 breached and nothing was written.
      { queued: 'rejected', amount: undefined, dailyLimit: '100' }
    ]).toContainEqual({ queued: queued.status, amount: inserted?.amount, dailyLimit: stored?.dailyLimit });
  });

  it('admits a transaction the raised limit allows once the save has committed', async () => {
    await spendingLimits.put({
      accountId: 'account-a',
      faucetId: 'faucet-a',
      dailyLimit: '50',
      asset: { symbol: 'MIDEN', decimals: 8 },
      revision: 'revision-1',
      createdAt: NOW - 100,
      updatedAt: NOW - 50
    });
    const transaction = new SendTransaction('account-a', 80n, 'account-b', 'faucet-a', NoteTypeEnum.Public);
    transaction.id = 'candidate';
    transaction.initiatedAt = NOW;

    // The deterministic half of the race above: 80 is over the old cap and under the new one, so
    // this can only pass if the queue re-reads the policy rather than caching the pre-save value.
    await save(draft({ dailyLimit: 100n, weeklyLimit: undefined }), 'revision-1', true, 'revision-2');
    await queueOutgoingTransaction(transaction, undefined, NOW);

    await expect(transactions.get('candidate')).resolves.toMatchObject({ amount: 80n });
  });
});
