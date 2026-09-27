import { DBCore, DBCoreIndex, Middleware } from 'dexie';

import { ITransaction, SendTransaction, Transaction } from '../db/types';
import { db, spendingLimits, transactions } from '../repo';
import { NoteTypeEnum } from '../types';
import {
  assessOutgoingSpendingLimitDetails,
  hasSpendingLimits,
  QueueableOutgoingTransaction,
  queueOutgoingTransaction,
  spendsOf
} from './queue';
import {
  PersistedSpendingLimit,
  SpendingLimitAuthorization,
  SpendingLimitAuthorizationRequiredError,
  SpendingLimitPriceUnavailableError,
  spendsDigest
} from './types';
import { resolveSpendsUsd } from './valuation';

jest.mock('./valuation', () => ({ resolveSpendsUsd: jest.fn() }));

const mockedResolve = jest.mocked(resolveSpendsUsd);

const NOW = 2_000_000;
const ACCOUNT = 'account-a';

const config = (overrides: Partial<PersistedSpendingLimit> = {}): PersistedSpendingLimit => ({
  accountId: ACCOUNT,
  limit: '50000000',
  revision: 'revision-1',
  createdAt: 1,
  updatedAt: 1,
  ...overrides
});

const saveConfig = (overrides: Partial<PersistedSpendingLimit> = {}) => spendingLimits.put(config(overrides));

const sendRow = (amount = 1n, id = 'tx-1'): SendTransaction => {
  const transaction = new SendTransaction(ACCOUNT, amount, 'account-b', 'eth', NoteTypeEnum.Public);
  transaction.id = id;
  transaction.initiatedAt = NOW;
  return transaction;
};

const executeRow = (id = 'tx-1'): Transaction => {
  const transaction = new Transaction(ACCOUNT, new Uint8Array([1]));
  transaction.id = id;
  transaction.initiatedAt = NOW;
  return transaction;
};

// What `spendsOf(sendRow())` states by default - the spends most tests below actually queue.
const DEFAULT_AUTHORIZED_SPENDS = [{ faucetId: 'eth', amount: 1n }];

// A row inside the window, stamped the way the existing over-limit history tests stamp one
// (`{ ...sendRow(...), spentUsd: 40_000_000n }`), so a stored row counts toward the cap exactly
// as a real one does.
const historyRow = (overrides: Partial<ITransaction> = {}): ITransaction => ({
  ...sendRow(90n, overrides.id ?? 'existing'),
  spentUsd: 40_000_000n,
  ...overrides
});

const proposalFor = (transaction: QueueableOutgoingTransaction) => ({
  accountId: transaction.accountId,
  spends: spendsOf(transaction),
  now: NOW
});

/** Writes a row straight to IndexedDB, below Dexie's hooks, as an older build or a tampered store could have. */
const putStoredRow = async (row: object) => {
  await db.open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.backendDB().transaction('transactions', 'readwrite');
    tx.objectStore('transactions').put(row);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

/** Every count and query that reaches the `transactions` store while `run` executes, sorted. */
const recordHistoryReads = async (run: () => Promise<unknown>): Promise<string[]> => {
  const reads: string[] = [];
  const indexName = (index: DBCoreIndex) => (index.isPrimaryKey ? 'primary key' : index.name);
  const recorder: Middleware<DBCore> = {
    stack: 'dbcore',
    name: 'history-read-recorder',
    create: down => ({
      ...down,
      table: name => {
        const table = down.table(name);
        if (name !== 'transactions') return table;
        return {
          ...table,
          count: req => {
            reads.push(`count ${indexName(req.query.index)}`);
            return table.count(req);
          },
          query: req => {
            reads.push(`query ${indexName(req.query.index)}`);
            return table.query(req);
          }
        };
      }
    })
  };
  // A middleware joins the stack only when the database opens.
  db.close();
  db.use(recorder);
  await db.open();
  try {
    await run();
  } finally {
    db.unuse({ stack: 'dbcore', name: 'history-read-recorder' });
    db.close();
    await db.open();
  }
  return reads.sort();
};

const usdAuthorization = (
  overrides: Partial<{
    accountId: string;
    usdAmount: bigint;
    spends: { faucetId: string; amount: bigint }[];
    revision: string;
    issuedAt: number;
    expiresAt: number;
    id: string;
  }> = {}
): SpendingLimitAuthorization => ({
  kind: 'usd',
  id: overrides.id ?? 'authorization-1',
  accountId: overrides.accountId ?? ACCOUNT,
  usdAmount: overrides.usdAmount ?? 60_000_000n,
  spendsDigest: spendsDigest(overrides.spends ?? DEFAULT_AUTHORIZED_SPENDS),
  revision: overrides.revision ?? 'revision-1',
  issuedAt: overrides.issuedAt ?? NOW - 1,
  expiresAt: overrides.expiresAt ?? NOW + 119
});

const unpricedAuthorization = (
  accountId: string,
  spends: { faucetId: string; amount: bigint }[],
  revision: string,
  overrides: Partial<{ issuedAt: number; expiresAt: number; id: string }> = {}
): SpendingLimitAuthorization => ({
  kind: 'unpriced',
  id: overrides.id ?? 'authorization-1',
  accountId,
  spendsDigest: spendsDigest(spends),
  revision,
  issuedAt: overrides.issuedAt ?? NOW - 1,
  expiresAt: overrides.expiresAt ?? NOW + 119
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('queueOutgoingTransaction', () => {
  it('does not resolve a price for an account with no limit', async () => {
    await queueOutgoingTransaction(sendRow(), [{ faucetId: 'eth', amount: 1n }], undefined, NOW);

    expect(mockedResolve).not.toHaveBeenCalled();
    await expect(transactions.get('tx-1')).resolves.toBeDefined();
  });

  it('queues below the configured limit without an authorization', async () => {
    await saveConfig();
    mockedResolve.mockResolvedValue(50_000_000n);

    await queueOutgoingTransaction(sendRow(), spendsOf(sendRow()), undefined, NOW);

    // Assert the row exists BEFORE asserting its shape: `.not.toHaveProperty` on an absent row
    // resolves undefined and passes, which is the same result as the insert never happening. This
    // is also the only test of the exact boundary proposedTotal === limit.
    await expect(transactions.get('tx-1')).resolves.toMatchObject({ spentUsd: 50_000_000n });
    expect(await transactions.get('tx-1')).not.toHaveProperty('spendingLimitAuthorizationId');
  });

  it('rejects an over-limit transaction with a structured breach and no inserted row', async () => {
    await saveConfig();
    mockedResolve.mockResolvedValue(60_000_000n);

    await expect(queueOutgoingTransaction(sendRow(), spendsOf(sendRow()), undefined, NOW)).rejects.toMatchObject({
      code: 'SPENDING_LIMIT_AUTHORIZATION_REQUIRED',
      assessment: {
        accountId: ACCOUNT,
        usdAmount: 60_000_000n,
        breach: { spent: 0n, proposedTotal: 60_000_000n, limit: 50_000_000n, overBy: 10_000_000n }
      }
    });
    await expect(transactions.get('tx-1')).resolves.toBeUndefined();
  });

  it('fails closed when a matching policy record is malformed', async () => {
    await saveConfig({ limit: '01' });
    mockedResolve.mockResolvedValue(1n);

    await expect(queueOutgoingTransaction(sendRow(), spendsOf(sendRow()), undefined, NOW)).rejects.toThrow(
      /policy is unavailable/i
    );
    await expect(transactions.get('tx-1')).resolves.toBeUndefined();
  });

  it('turns a policy storage read failure into a fail-closed policy error', async () => {
    const read = jest.spyOn(spendingLimits, 'get').mockRejectedValueOnce(new Error('storage offline'));

    try {
      await expect(queueOutgoingTransaction(sendRow(), spendsOf(sendRow()), undefined, NOW)).rejects.toThrow(
        /policy is unavailable/i
      );
      await expect(transactions.get('tx-1')).resolves.toBeUndefined();
    } finally {
      read.mockRestore();
    }
  });

  it('turns a history read failure into a fail-closed policy error', async () => {
    await saveConfig();
    mockedResolve.mockResolvedValue(1n);
    // The failure lands on the window read, the second `where('initiatedAt')` call. The first is the
    // count that chooses between the window and the whole table, and failing it instead would leave
    // the window read's own failure untested.
    const where = transactions.where.bind(transactions);
    const read = jest
      .spyOn(transactions, 'where')
      .mockImplementationOnce(where)
      .mockImplementationOnce(() => {
        throw new Error('history offline');
      });

    try {
      await expect(queueOutgoingTransaction(sendRow(), spendsOf(sendRow()), undefined, NOW)).rejects.toThrow(
        /policy is unavailable/i
      );
      await expect(transactions.get('tx-1')).resolves.toBeUndefined();
    } finally {
      read.mockRestore();
    }
  });

  it.each([
    ['missing', undefined],
    ['NaN', Number.NaN],
    ['null', null],
    ['negative', -1]
  ])('refuses as unavailable when a counted row has a %s initiatedAt the index cannot place', async (_label, value) => {
    await saveConfig();
    mockedResolve.mockResolvedValue(1n);
    const stored = { ...historyRow({ id: 'stored-1' }) };
    if (value === undefined) delete (stored as { initiatedAt?: number }).initiatedAt;
    else Reflect.set(stored, 'initiatedAt', value);
    await putStoredRow(stored);

    await expect(queueOutgoingTransaction(sendRow(), spendsOf(sendRow()), undefined, NOW)).rejects.toThrow(
      /policy is unavailable/i
    );
    await expect(assessOutgoingSpendingLimitDetails(proposalFor(sendRow()))).rejects.toThrow(/policy is unavailable/i);
  });

  it('does not refuse when the unplaceable row is a restored one, which the policy skips', async () => {
    await saveConfig();
    mockedResolve.mockResolvedValue(1n);
    const stored = { ...historyRow({ id: 'stored-1' }), restoredFromBackup: true };
    delete (stored as { initiatedAt?: number }).initiatedAt;
    await putStoredRow(stored);

    await expect(queueOutgoingTransaction(sendRow(), spendsOf(sendRow()), undefined, NOW)).resolves.not.toThrow();
    await expect(transactions.get('tx-1')).resolves.toMatchObject({ spentUsd: 1n });
  });

  it('reads the whole table only when a row cannot be placed by the index', async () => {
    await saveConfig();
    mockedResolve.mockResolvedValue(1n);
    await transactions.add(historyRow({ id: 'placed-1' }));
    const wholeTable = jest.spyOn(transactions, 'toArray');

    try {
      await queueOutgoingTransaction(sendRow(), spendsOf(sendRow()), undefined, NOW);
      expect(wholeTable).not.toHaveBeenCalled();
    } finally {
      wholeTable.mockRestore();
    }
  });

  it('places rows at initiatedAt 0 and -0 by the index, so it reads only the window', async () => {
    await saveConfig();
    mockedResolve.mockResolvedValue(1n);
    await transactions.bulkAdd([
      historyRow({ id: 'zero', initiatedAt: 0 }),
      historyRow({ id: 'negative-zero', initiatedAt: -0 })
    ]);
    const wholeTable = jest.spyOn(transactions, 'toArray');

    try {
      await queueOutgoingTransaction(sendRow(), spendsOf(sendRow()), undefined, NOW);
      await assessOutgoingSpendingLimitDetails(proposalFor(sendRow()));
      expect(wholeTable).not.toHaveBeenCalled();
    } finally {
      wholeTable.mockRestore();
    }
  });

  it.each([
    ['a preflight', () => assessOutgoingSpendingLimitDetails(proposalFor(sendRow()))],
    ['the queue', () => queueOutgoingTransaction(sendRow(), spendsOf(sendRow()), undefined, NOW)]
  ])('%s counts the table and the index once, then reads only the window', async (_label, assess) => {
    await saveConfig();
    mockedResolve.mockResolvedValue(1n);
    await transactions.add(historyRow({ id: 'placed-1' }));

    await expect(recordHistoryReads(assess)).resolves.toEqual([
      'count initiatedAt',
      'count primary key',
      'query initiatedAt'
    ]);
  });

  it('reads the whole table and not the window when a row cannot be placed', async () => {
    await saveConfig();
    mockedResolve.mockResolvedValue(1n);
    const stored = { ...historyRow({ id: 'stored-1' }), restoredFromBackup: true };
    delete (stored as { initiatedAt?: number }).initiatedAt;
    await putStoredRow(stored);

    await expect(
      recordHistoryReads(() => queueOutgoingTransaction(sendRow(), spendsOf(sendRow()), undefined, NOW))
    ).resolves.toEqual(['count initiatedAt', 'count primary key', 'query primary key']);
  });

  it.each([
    ['a preflight', (id: string) => assessOutgoingSpendingLimitDetails(proposalFor(sendRow(1n, id)))],
    ['the queue', (id: string) => queueOutgoingTransaction(sendRow(1n, id), spendsOf(sendRow(1n, id)), undefined, NOW)]
  ])(
    '%s skips an old matching send stamped 1.5 whether it reads the window or the whole table',
    async (_label, assess) => {
      await saveConfig();
      mockedResolve.mockResolvedValue(1n);
      await putStoredRow(historyRow({ id: 'old-send', initiatedAt: 1.5 }));
      const windowOutcome = await assess('tx-1');

      // An incoming row the policy never counts, but whose missing initiatedAt forces the whole-table read.
      const incoming = { ...historyRow({ id: 'incoming' }), type: 'consume' };
      Reflect.deleteProperty(incoming, 'initiatedAt');
      await putStoredRow(incoming);

      await expect(assess('tx-2')).resolves.toEqual(windowOutcome);
    }
  );

  it.each([
    ['account mismatch', { accountId: 'account-b' }],
    ['spends mismatch', { spends: [{ faucetId: 'eth', amount: 2n }] }],
    ['stale revision', { revision: 'revision-old' }],
    ['expired', { expiresAt: NOW }],
    ['issued in the future', { issuedAt: NOW + 1, expiresAt: NOW + 2 }],
    ['lifetime over two minutes', { issuedAt: NOW - 1, expiresAt: NOW + 120 }],
    ['missing id', { id: '' }]
  ])('rejects an over-limit transaction with %s authorization', async (_label, overrides) => {
    await saveConfig();
    mockedResolve.mockResolvedValue(60_000_000n);

    await expect(
      queueOutgoingTransaction(sendRow(), spendsOf(sendRow()), usdAuthorization(overrides), NOW)
    ).rejects.toBeInstanceOf(SpendingLimitAuthorizationRequiredError);
    await expect(transactions.get('tx-1')).resolves.toBeUndefined();
  });

  it('rejects an unpriced-kind authorization offered for a priced breach', async () => {
    await saveConfig();
    mockedResolve.mockResolvedValue(60_000_000n);
    const spends = [{ faucetId: 'eth', amount: 1n }];

    await expect(
      queueOutgoingTransaction(sendRow(), spends, unpricedAuthorization(ACCOUNT, spends, 'revision-1'), NOW)
    ).rejects.toBeInstanceOf(SpendingLimitAuthorizationRequiredError);
    await expect(transactions.get('tx-1')).resolves.toBeUndefined();
  });

  it('consumes one exact authorization on the inserted row', async () => {
    await saveConfig();
    mockedResolve.mockResolvedValue(60_000_000n);

    await queueOutgoingTransaction(sendRow(), spendsOf(sendRow()), usdAuthorization(), NOW);

    await expect(transactions.get('tx-1')).resolves.toMatchObject({ spendingLimitAuthorizationId: 'authorization-1' });
  });

  it('accepts a usd authorization whose dollar figure has drifted since it was minted', async () => {
    // The authorization was minted at 60_000_000n (the pre-check's figure); a price refresh before
    // queue time revalues the SAME spends at 70_000_000n. The user consented to these assets and
    // amounts, not to a frozen dollar figure, so the mismatch must not re-challenge them.
    await saveConfig();
    mockedResolve.mockResolvedValue(70_000_000n);

    await queueOutgoingTransaction(sendRow(), spendsOf(sendRow()), usdAuthorization({ usdAmount: 60_000_000n }), NOW);

    await expect(transactions.get('tx-1')).resolves.toMatchObject({
      spentUsd: 70_000_000n,
      spendingLimitAuthorizationId: 'authorization-1'
    });
  });

  it('rejects replay of an authorization already attached to a row', async () => {
    await saveConfig();
    mockedResolve.mockResolvedValue(60_000_000n);
    await queueOutgoingTransaction(sendRow(1n, 'first'), spendsOf(sendRow(1n, 'first')), usdAuthorization(), NOW);

    await expect(
      queueOutgoingTransaction(sendRow(1n, 'replay'), spendsOf(sendRow(1n, 'replay')), usdAuthorization(), NOW)
    ).rejects.toBeInstanceOf(SpendingLimitAuthorizationRequiredError);
    await expect(transactions.get('replay')).resolves.toBeUndefined();
  });

  it('serializes concurrent insertions so both cannot consume the same remaining allowance', async () => {
    await saveConfig();
    mockedResolve.mockResolvedValue(30_000_000n);

    const results = await Promise.allSettled([
      queueOutgoingTransaction(sendRow(1n, 'first'), spendsOf(sendRow(1n, 'first')), undefined, NOW),
      queueOutgoingTransaction(sendRow(1n, 'second'), spendsOf(sendRow(1n, 'second')), undefined, NOW)
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await transactions.count()).toBe(1);
  });

  it('rechecks a previously allowed preflight after a preceding insertion wins the race', async () => {
    await saveConfig();
    mockedResolve.mockResolvedValue(30_000_000n);
    await queueOutgoingTransaction(sendRow(1n, 'first'), spendsOf(sendRow(1n, 'first')), undefined, NOW);

    await expect(
      queueOutgoingTransaction(sendRow(1n, 'raced'), spendsOf(sendRow(1n, 'raced')), undefined, NOW)
    ).rejects.toMatchObject({
      assessment: { breach: { spent: 30_000_000n, proposedTotal: 60_000_000n, limit: 50_000_000n } }
    });
    await expect(transactions.get('raced')).resolves.toBeUndefined();
  });

  it('sums several assets into one charge and accepts one authorization for the total', async () => {
    mockedResolve.mockResolvedValue(75_000_000n);
    await saveConfig({ limit: '50000000', revision: 'rev-1' });
    const spends = [
      { faucetId: 'eth', amount: 1n },
      { faucetId: 'usdc', amount: 2n }
    ];

    await queueOutgoingTransaction(
      executeRow(),
      spends,
      usdAuthorization({ accountId: ACCOUNT, usdAmount: 75_000_000n, spends, revision: 'rev-1' }),
      NOW
    );

    await expect(transactions.get('tx-1')).resolves.toMatchObject({ spentUsd: 75_000_000n });
  });

  it('refuses a transaction whose price is unavailable when a limit exists', async () => {
    mockedResolve.mockRejectedValue(new SpendingLimitPriceUnavailableError('ETH'));
    await saveConfig({ limit: '50000000', revision: 'rev-1' });

    await expect(
      queueOutgoingTransaction(sendRow(), [{ faucetId: 'eth', amount: 1n }], undefined, NOW)
    ).rejects.toBeInstanceOf(SpendingLimitPriceUnavailableError);
    await expect(transactions.get('tx-1')).resolves.toBeUndefined();
  });

  it('lets an unrelated valuation failure propagate unchanged, rather than mapping it to price-unavailable', async () => {
    // Only `SpendingLimitPriceUnavailableError` is a recoverable "no price right now" refusal; any
    // other failure resolving the spend is a genuine bug or storage fault and must surface as
    // itself, not be silently absorbed into the price-unavailable retry story.
    const valuationBug = new TypeError('faucet metadata missing decimals');
    mockedResolve.mockRejectedValue(valuationBug);
    await saveConfig({ limit: '50000000', revision: 'rev-1' });

    await expect(queueOutgoingTransaction(sendRow(), [{ faucetId: 'eth', amount: 1n }], undefined, NOW)).rejects.toBe(
      valuationBug
    );
    await expect(transactions.get('tx-1')).resolves.toBeUndefined();
  });

  it('falls through to the no-limit path when the policy is removed between the probe and the lock', async () => {
    // The account had a cap when `queueOutgoingTransaction` made its first (unlocked) policy read,
    // so the pre-check at the top of the function does not take the fast "no limit" path. By the
    // time the write-locked transaction re-reads it, the cap is gone - the same race the top-level
    // probe already guards against, one level deeper.
    await saveConfig();
    mockedResolve.mockResolvedValue(30_000_000n);
    const originalGet = spendingLimits.get.bind(spendingLimits);
    const read = jest.spyOn(spendingLimits, 'get').mockImplementationOnce(originalGet).mockResolvedValueOnce(undefined);

    try {
      await queueOutgoingTransaction(sendRow(), spendsOf(sendRow()), undefined, NOW);

      const inserted = await transactions.get('tx-1');
      expect(inserted).toBeDefined();
      // Not stamped or assessed at all: the row takes the same shape as any other no-limit insert,
      // proving the assessed/breach path never ran even though a price WAS already resolved above.
      expect(inserted).not.toHaveProperty('spentUsd');
      expect(inserted).not.toHaveProperty('spendingLimitAuthorizationId');
    } finally {
      read.mockRestore();
    }
  });

  it('accepts an unpriced-kind authorization bound to exactly these spends', async () => {
    mockedResolve.mockRejectedValue(new SpendingLimitPriceUnavailableError('ETH'));
    await saveConfig({ limit: '50000000', revision: 'rev-1' });
    const spends = [{ faucetId: 'eth', amount: 5n }];

    await queueOutgoingTransaction(sendRow(), spends, unpricedAuthorization(ACCOUNT, spends, 'rev-1'), NOW);

    // Not `toMatchObject({ spentUsd: undefined })`: Jest's toMatchObject requires the key to be
    // PRESENT (even as undefined) to match, and a row this branch inserts never carries the key at
    // all - the wallet never learned a value to stamp. `not.toHaveProperty` is the accurate check.
    const inserted = await transactions.get('tx-1');
    expect(inserted).toBeDefined();
    expect(inserted).not.toHaveProperty('spentUsd');
  });

  it('rejects an unpriced authorization minted for different spends', async () => {
    mockedResolve.mockRejectedValue(new SpendingLimitPriceUnavailableError('ETH'));
    await saveConfig({ limit: '50000000', revision: 'rev-1' });

    await expect(
      queueOutgoingTransaction(
        sendRow(),
        [{ faucetId: 'eth', amount: 5n }],
        unpricedAuthorization(ACCOUNT, [{ faucetId: 'eth', amount: 4n }], 'rev-1'),
        NOW
      )
    ).rejects.toBeInstanceOf(SpendingLimitPriceUnavailableError);
  });
});

describe('default assessment clock', () => {
  // Every other test injects `now`, so the fallback the PRODUCTION callers actually take was never
  // executed: the initiate paths all reach these functions without a time. Asserting the stamp is
  // the real clock, rather than the fixture's NOW, is what proves the fallback ran. Fake timers
  // are deliberately not used here - they stall the Dexie transaction the queue opens.
  it('assesses against the wall clock when no time is supplied', async () => {
    await saveConfig();
    mockedResolve.mockResolvedValue(20_000_000n);

    const details = await assessOutgoingSpendingLimitDetails({
      accountId: ACCOUNT,
      spends: [{ faucetId: 'eth', amount: 1n }]
    });

    expect(details?.assessment.assessedAt).toBeGreaterThan(1_700_000_000);
  });

  it('queues against the wall clock when no time is supplied', async () => {
    await saveConfig();
    mockedResolve.mockResolvedValue(1n);
    const candidate = sendRow();

    await queueOutgoingTransaction(candidate, spendsOf(candidate));

    await expect(transactions.get('tx-1')).resolves.toBeDefined();
  });
});

describe('assessOutgoingSpendingLimitDetails', () => {
  it('preflights the current policy and history without inserting a row', async () => {
    await saveConfig();
    await transactions.add({ ...sendRow(90n, 'existing'), spentUsd: 40_000_000n });
    mockedResolve.mockResolvedValue(20_000_000n);

    await expect(
      assessOutgoingSpendingLimitDetails({ accountId: ACCOUNT, spends: [{ faucetId: 'eth', amount: 1n }], now: NOW })
    ).resolves.toMatchObject({
      assessment: { usdAmount: 20_000_000n, revision: 'revision-1', breach: { overBy: 10_000_000n } }
    });
    await expect(transactions.count()).resolves.toBe(1);
  });

  it('returns no preflight assessment when no policy is configured', async () => {
    await expect(
      assessOutgoingSpendingLimitDetails({ accountId: ACCOUNT, spends: [{ faucetId: 'eth', amount: 1n }], now: NOW })
    ).resolves.toBeUndefined();
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it('rethrows a price-unavailable refusal so callers can tell the two apart', async () => {
    await saveConfig();
    mockedResolve.mockRejectedValue(new SpendingLimitPriceUnavailableError('ETH'));

    await expect(
      assessOutgoingSpendingLimitDetails({ accountId: ACCOUNT, spends: [{ faucetId: 'eth', amount: 1n }], now: NOW })
    ).rejects.toBeInstanceOf(SpendingLimitPriceUnavailableError);
  });
});

describe('hasSpendingLimits', () => {
  it('answers false when the account has no configured limit', async () => {
    await expect(hasSpendingLimits(ACCOUNT)).resolves.toBe(false);
  });

  it('answers true when the account has a configured limit', async () => {
    await saveConfig();

    await expect(hasSpendingLimits(ACCOUNT)).resolves.toBe(true);
  });

  it('matches the account through its canonical identity, not its spelling', async () => {
    await saveConfig();

    // A composite `<address>_<suffix>` and the bare address are the same account; answering false
    // here would silently drop the refusal for a wallet that has a limit set.
    await expect(hasSpendingLimits(`${ACCOUNT}_route`)).resolves.toBe(true);
  });

  it('fails closed when the configuration store cannot be read', async () => {
    const read = jest.spyOn(spendingLimits, 'get').mockRejectedValueOnce(new Error('storage offline'));

    try {
      await expect(hasSpendingLimits(ACCOUNT)).rejects.toThrow(/policy is unavailable/i);
    } finally {
      read.mockRestore();
    }
  });
});
