import type { TransactionResult } from '@miden-sdk/miden-sdk/lazy';

import { SharedEarnLocks, deferred } from 'lib/epoch/testing/earn-locks';
import { IBridgeInInfo, ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import {
  applyBridgeInInfoForNotes,
  applyBridgeInToConsumeRow,
  findPendingBridgeInByEarnWithdrawTxId,
  registerPendingBridgeIn,
  resolveBridgeInNoteId,
  suppressedLinkedConsumeIds,
  type PendingBridgeInIntent
} from './bridge-in';
import { completeConsumeTransaction } from '../transaction/complete';

const mockRegistry: { records: PendingBridgeInIntent[] } = { records: [] };
let mockFailRemoval = false;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
jest.mock('../front/storage', () => ({
  fetchFromStorage: async () => clone(mockRegistry.records),
  putToStorage: async (_key: string, value: PendingBridgeInIntent[]) => {
    if (mockFailRemoval && value.length === 0) {
      mockFailRemoval = false;
      throw new Error('removal unavailable');
    }
    mockRegistry.records = clone(value);
  }
}));
jest.mock('../sdk/helpers', () => ({
  ...jest.requireActual('../sdk/helpers'),
  getBech32AddressFromAccountId: (id: string) => id
}));
const mockStatus = jest.fn();
jest.mock('lib/epoch/sdk', () => ({ getEpochReadOnlySdk: async () => ({ getIntentStatus: mockStatus }) }));
const mockReadIntentStatus = jest.fn();
jest.mock('lib/epoch/intent-status', () => ({
  readEpochIntentStatus: (...args: unknown[]) => mockReadIntentStatus(...args)
}));

const OWNER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const KEY = 'withdraw';
const info = (extra: Partial<IBridgeInInfo> = {}): IBridgeInInfo => ({
  provider: 'epoch',
  sourceAmount: '10',
  sourceSymbol: 'USDC',
  earnWithdrawTxId: KEY,
  earnWithdrawAttemptId: 'attempt-1',
  ...extra
});
const withdrawal = (extra: Record<string, unknown> = {}): ITransaction => ({
  id: KEY,
  type: 'earn-withdraw',
  accountId: 'account',
  status: ITransactionStatus.Completed,
  initiatedAt: 1,
  completedAt: 1,
  displayIcon: 'DEFAULT',
  amount: 10n,
  faucetId: 'faucet',
  extraInputs: {
    evmOwner: OWNER,
    phase: 'redeeming',
    submissionAttemptId: 'attempt-1',
    withdrawIntentNonce: '7',
    marketUid: 'market',
    destinationFaucetId: 'faucet',
    sourceAmount: '10',
    sourceSymbol: 'USDC',
    ...extra
  }
});
const consume = (id = 'consume', noteId = '0xAbCd'): ITransaction => ({
  id,
  type: 'consume',
  accountId: 'account',
  status: ITransactionStatus.Completed,
  displayIcon: 'RECEIVE',
  initiatedAt: 2,
  completedAt: 2,
  noteIds: [noteId],
  amount: 12n,
  faucetId: 'faucet',
  transactionId: 'chain-tx'
});
const bridgeReceive = (): ITransaction => ({
  id: 'bridge-receive',
  type: 'bridged-receive',
  accountId: 'account',
  status: ITransactionStatus.Completed,
  displayIcon: 'RECEIVE',
  initiatedAt: 1,
  extraInputs: { provider: 'epoch', phase: 'delivering' }
});
const applyConsume = (value: IBridgeInInfo) => applyBridgeInToConsumeRow('consume', value);

beforeEach(async () => {
  mockRegistry.records = [];
  mockFailRemoval = false;
  mockStatus.mockReset().mockResolvedValue([]);
  mockReadIntentStatus
    .mockReset()
    .mockImplementation(
      (sdk: { getIntentStatus: (address: string, nonce: string) => unknown }, address: string, nonce: string) =>
        sdk.getIntentStatus(address, nonce)
    );
  Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
  await Repo.transactions.clear();
});
afterEach(() => {
  Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
});

it('keeps equal nonces belonging to different owners and deduplicates address case variants', async () => {
  await Promise.all([
    registerPendingBridgeIn(OWNER, '7', info()),
    registerPendingBridgeIn(OTHER, '7', info({ earnWithdrawTxId: 'other' }))
  ]);
  await registerPendingBridgeIn(OWNER.toUpperCase(), '7', info());
  expect(mockRegistry.records).toHaveLength(2);
  await resolveBridgeInNoteId(OTHER, '7', 'other-note');
  expect(mockRegistry.records.find(row => row.userAddress === OWNER)?.midenNoteId).toBeUndefined();
  expect(mockRegistry.records.find(row => row.userAddress === OTHER)?.midenNoteId).toBe('other-note');
});

it.each([
  ['abcd', '0xAbCd'],
  ['0xABCD', 'abCd']
])('resolves %s against indexed consume note %s', async (reported, stored) => {
  await Repo.transactions.bulkAdd([withdrawal({ withdrawIntentNonce: undefined }), consume('consume', stored)]);
  await registerPendingBridgeIn(OWNER, '7', info({ intentOwner: OTHER, intentNonce: 'wrong' }));
  await resolveBridgeInNoteId(OWNER, '7', reported);
  expect((await Repo.transactions.get(KEY))?.extraInputs).toEqual(
    expect.objectContaining({ phase: 'received', midenNoteId: reported })
  );
  expect((await Repo.transactions.get('consume'))?.extraInputs.bridgeIn).toEqual(
    expect.objectContaining({ intentOwner: OWNER, intentNonce: '7', earnWithdrawAttemptId: 'attempt-1' })
  );
  expect(mockRegistry.records).toEqual([]);
});

it.each(['consume', 'withdraw', 'bridge-receive', 'registry'])(
  'retains a replayable anchor when the %s write fails',
  async failing => {
    await Repo.transactions.bulkAdd([withdrawal({ withdrawIntentNonce: undefined }), consume(), bridgeReceive()]);
    await registerPendingBridgeIn(OWNER, '7', info({ bridgeReceiveTxId: 'bridge-receive' }));
    let fail = true;
    const hook = (_changes: object, key: unknown) => {
      if (fail && key === failing) {
        fail = false;
        throw new Error('database unavailable');
      }
    };
    Repo.transactions.hook('updating', hook);
    mockFailRemoval = failing === 'registry';
    try {
      await expect(resolveBridgeInNoteId(OWNER, '7', 'abcd')).rejects.toThrow();
      expect(mockRegistry.records).toHaveLength(1);
      expect(mockRegistry.records[0]?.midenNoteId).toBe('abcd');
    } finally {
      Repo.transactions.hook('updating').unsubscribe(hook);
    }
    await resolveBridgeInNoteId(OWNER, '7', 'abcd');
    expect((await Repo.transactions.get(KEY))?.extraInputs.phase).toBe('received');
    expect((await Repo.transactions.get('bridge-receive'))?.extraInputs.phase).toBe('received');
    expect(mockRegistry.records).toEqual([]);
  }
);

it('keeps a discovered note durable when the consume callback fails after tagging', async () => {
  await Repo.transactions.bulkAdd([withdrawal({ withdrawIntentNonce: undefined }), consume()]);
  await registerPendingBridgeIn(OWNER, '7', info());
  mockStatus.mockResolvedValue([{ midenNoteId: 'abcd' }]);
  await expect(
    applyBridgeInInfoForNotes(['0xABCD'], async value => {
      await applyConsume(value);
      throw new Error('interrupted completion');
    })
  ).rejects.toThrow('interrupted completion');
  expect(mockRegistry.records[0]?.midenNoteId).toBe('abcd');
  mockStatus.mockClear();
  expect(await applyBridgeInInfoForNotes(['abcd'], applyConsume)).toBe(true);
  expect(mockStatus).not.toHaveBeenCalled();
  expect(mockRegistry.records).toEqual([]);
});

it('reads through the status timeout, so a timed-out read lets consume discovery finish', async () => {
  await registerPendingBridgeIn(OWNER, '7', info());
  mockReadIntentStatus.mockRejectedValueOnce(new Error('Epoch intent status timed out after 15000 ms'));
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);

  await expect(applyBridgeInInfoForNotes(['abcd'], applyConsume)).resolves.toBe(false);

  expect(mockReadIntentStatus).toHaveBeenCalledWith(expect.anything(), OWNER, '7');
  expect(mockStatus).not.toHaveBeenCalled();
});

it('reads every unresolved intent at once, so discovery waits one status read however many are pending', async () => {
  await registerPendingBridgeIn(OWNER, '7', info());
  await registerPendingBridgeIn(OTHER, '8', info({ earnWithdrawTxId: 'other' }));
  const first = deferred<unknown[]>(),
    second = deferred<unknown[]>();
  mockReadIntentStatus.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

  const pending = applyBridgeInInfoForNotes(['abcd'], applyConsume);
  for (let i = 0; i < 50 && mockReadIntentStatus.mock.calls.length < 2; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  expect(mockReadIntentStatus).toHaveBeenCalledTimes(2);

  first.resolve([]);
  second.resolve([]);
  await expect(pending).resolves.toBe(false);
});

it('names the intent in the warning for each status read that fails', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  await registerPendingBridgeIn(OWNER, '7', info());
  await registerPendingBridgeIn(OTHER, '8', info({ earnWithdrawTxId: 'other' }));
  mockReadIntentStatus.mockRejectedValue(new Error('allocator down'));

  await expect(applyBridgeInInfoForNotes(['abcd'], applyConsume)).resolves.toBe(false);

  // The reads run at once, so only the intent tells their warnings apart.
  expect(warn).toHaveBeenCalledWith('[bridge-in] one-shot intent poll failed', OWNER, '7', expect.any(Error));
  expect(warn).toHaveBeenCalledWith('[bridge-in] one-shot intent poll failed', OTHER, '8', expect.any(Error));
  warn.mockRestore();
});

it('stops waiting on unrelated intents once a read finds the consumed note', async () => {
  await registerPendingBridgeIn(OTHER, '8', info({ earnWithdrawTxId: 'other' }));
  await registerPendingBridgeIn(OWNER, '7', info());
  const matching = deferred<unknown[]>();
  mockReadIntentStatus.mockReturnValueOnce(new Promise(() => {})).mockReturnValueOnce(matching.promise);
  const apply = jest.fn(async () => undefined);

  const settled = jest.fn();
  void applyBridgeInInfoForNotes(['abcd'], apply).then(settled);
  for (let i = 0; i < 50 && mockReadIntentStatus.mock.calls.length < 2; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  // The unrelated read started first and never answers.
  expect(mockReadIntentStatus).toHaveBeenCalledTimes(2);

  matching.resolve([{ midenNoteId: 'abcd' }]);
  for (let i = 0; i < 50 && settled.mock.calls.length === 0; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  expect(settled).toHaveBeenCalledWith(true);
  expect(apply).toHaveBeenCalledWith(expect.objectContaining({ intentOwner: OWNER, intentNonce: '7' }));
});

it('does not lose a registration while consume discovery waits on the network', async () => {
  await registerPendingBridgeIn(OWNER, '7', info());
  const entered = deferred<void>(),
    response = deferred<unknown[]>();
  mockStatus.mockImplementation(async () => {
    entered.resolve();
    return response.promise;
  });
  const applied: IBridgeInInfo[] = [];
  const pending = applyBridgeInInfoForNotes(['abcd'], async value => {
    applied.push(value);
  });
  await entered.promise;
  await registerPendingBridgeIn(OTHER, '8', info({ earnWithdrawTxId: 'other' }));
  expect(mockRegistry.records).toHaveLength(2);
  response.resolve([{ midenNoteId: 'abcd' }]);
  expect(await pending).toBe(true);
  expect(applied[0]?.intentOwner).toBe(OWNER);
  expect(mockRegistry.records.map(row => row.userAddress)).toEqual([OTHER]);
});

it('does not resurrect a member resolved and removed during a parked status request', async () => {
  await Repo.transactions.bulkAdd([withdrawal(), consume()]);
  await registerPendingBridgeIn(OWNER, '7', info());
  const entered = deferred<void>(),
    response = deferred<unknown[]>();
  mockStatus.mockImplementation(async () => {
    entered.resolve();
    return response.promise;
  });
  const apply = jest.fn(async (_value: IBridgeInInfo) => {});
  const pending = applyBridgeInInfoForNotes(['abcd'], apply);
  await entered.promise;
  await resolveBridgeInNoteId(OWNER, '7', 'abcd');
  response.resolve([{ midenNoteId: 'abcd' }]);
  expect(await pending).toBe(false);
  expect(apply).not.toHaveBeenCalled();
  expect(mockRegistry.records).toEqual([]);
});

it('preserves a fresh note resolution over an older conflicting status response', async () => {
  await registerPendingBridgeIn(OWNER, '7', info());
  const entered = deferred<void>(),
    response = deferred<unknown[]>();
  mockStatus.mockImplementation(async () => {
    entered.resolve();
    return response.promise;
  });
  const apply = jest.fn(async (_value: IBridgeInInfo) => {});
  const pending = applyBridgeInInfoForNotes(['stale'], apply);
  await entered.promise;
  await resolveBridgeInNoteId(OWNER, '7', 'fresh');
  response.resolve([{ midenNoteId: 'stale' }]);
  expect(await pending).toBe(false);
  expect(mockRegistry.records[0]?.midenNoteId).toBe('fresh');
  expect(apply).not.toHaveBeenCalled();
});

it('serializes concurrent applications so a matching intent completes once', async () => {
  await registerPendingBridgeIn(OWNER, '7', info());
  await resolveBridgeInNoteId(OWNER, '7', 'abcd');
  const entered = deferred<void>(),
    release = deferred<void>();
  let completed = 0;
  const apply = async () => {
    entered.resolve();
    await release.promise;
    completed++;
  };
  const first = applyBridgeInInfoForNotes(['abcd'], apply);
  await entered.promise;
  const second = applyBridgeInInfoForNotes(['abcd'], apply);
  release.resolve();
  expect(await Promise.all([first, second])).toEqual([true, false]);
  expect(completed).toBe(1);
});

it('matches recovery only within the current withdrawal attempt, including legacy data', async () => {
  await registerPendingBridgeIn(OWNER, 'old', info({ earnWithdrawAttemptId: undefined }));
  await registerPendingBridgeIn(OWNER, 'new', info({ earnWithdrawAttemptId: 'attempt-2' }));
  expect(await findPendingBridgeInByEarnWithdrawTxId(KEY, KEY)).toEqual({ userAddress: OWNER, intentNonce: 'old' });
  expect(await findPendingBridgeInByEarnWithdrawTxId(KEY, 'attempt-2')).toEqual({
    userAddress: OWNER,
    intentNonce: 'new'
  });
  expect(await findPendingBridgeInByEarnWithdrawTxId(KEY, 'unknown')).toBeUndefined();
});

it('leaves an old delivery visible after its linked row starts a different attempt', async () => {
  await Repo.transactions.bulkAdd([
    withdrawal({ submissionAttemptId: 'attempt-2', withdrawIntentNonce: undefined }),
    consume()
  ]);
  await registerPendingBridgeIn(OWNER, '7', info());
  await resolveBridgeInNoteId(OWNER, '7', 'abcd');
  const current = await Repo.transactions.get(KEY);
  expect(current?.extraInputs.phase).toBe('redeeming');
  expect(current?.amount).toBe(10n);
  const oldConsume = await Repo.transactions.get('consume');
  if (!oldConsume) throw new Error('missing consume');
  expect(oldConsume.extraInputs.bridgeIn.intentOwner).toBe(OWNER);
  expect(await suppressedLinkedConsumeIds([oldConsume])).toEqual(new Set());
});

it('suppresses matching and legacy deliveries but not a predecessor attempt', async () => {
  const current = withdrawal();
  const legacy = withdrawal({ submissionAttemptId: undefined, withdrawIntentNonce: undefined });
  legacy.id = 'legacy';
  await Repo.transactions.bulkAdd([current, legacy]);
  const matching = {
    ...consume('matching'),
    extraInputs: { bridgeIn: info({ intentOwner: OWNER, intentNonce: '7' }) }
  };
  const previous = {
    ...consume('previous'),
    extraInputs: { bridgeIn: info({ intentOwner: OWNER, intentNonce: '7', earnWithdrawAttemptId: 'old' }) }
  };
  const old = {
    ...consume('legacy-consume'),
    extraInputs: { bridgeIn: { provider: 'epoch', earnWithdrawTxId: 'legacy' } }
  };
  expect(await suppressedLinkedConsumeIds([matching, previous, old])).toEqual(new Set(['matching', 'legacy-consume']));
});

it('shares the registry mutation lock across isolated module realms', async () => {
  const locks = new SharedEarnLocks();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
        let value!: T;
        await locks.request(name, { ifAvailable: false }, async () => {
          value = await operation();
        });
        return value;
      }
    }
  });
  const load = () => {
    let api: typeof import('./bridge-in') | undefined;
    jest.isolateModules(() => {
      api = require('./bridge-in');
    });
    if (!api) throw new Error('module not loaded');
    return api;
  };
  const a = load(),
    b = load();
  await Promise.all([
    a.registerPendingBridgeIn(OWNER, '7', info()),
    b.registerPendingBridgeIn(OTHER, '8', info({ earnWithdrawTxId: 'other' }))
  ]);
  expect(mockRegistry.records).toHaveLength(2);
  await a.resolveBridgeInNoteId(OWNER, '7', 'abcd');
  let completed = 0;
  expect(
    await Promise.all([
      a.applyBridgeInInfoForNotes(['abcd'], async () => {
        completed++;
      }),
      b.applyBridgeInInfoForNotes(['abcd'], async () => {
        completed++;
      })
    ])
  ).toEqual([true, false]);
  expect(completed).toBe(1);
  expect(locks.requests.length).toBeGreaterThan(0);
});

it('propagates a rejected Web Lock request without running the mutation unlocked', async () => {
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async () => {
        throw new Error('lock rejected');
      }
    }
  });
  await expect(registerPendingBridgeIn(OWNER, '7', info())).rejects.toThrow('lock rejected');
  expect(mockRegistry.records).toEqual([]);
});

it('retains bridge recovery when the completed consume lacks required delivery amounts', async () => {
  const row = consume();
  row.amount = undefined;
  await Repo.transactions.bulkAdd([row, bridgeReceive()]);
  await registerPendingBridgeIn(OWNER, '7', info({ earnWithdrawTxId: undefined, bridgeReceiveTxId: 'bridge-receive' }));
  await expect(resolveBridgeInNoteId(OWNER, '7', 'abcd')).rejects.toThrow();
  expect(mockRegistry.records).toHaveLength(1);
  expect((await Repo.transactions.get('bridge-receive'))?.extraInputs.phase).toBe('delivering');
});

it('keeps the real consume-completion path recoverable after a linked write fails', async () => {
  const row = consume();
  row.status = ITransactionStatus.GeneratingTransaction;
  await Repo.transactions.bulkAdd([withdrawal({ withdrawIntentNonce: undefined }), row]);
  await registerPendingBridgeIn(OWNER, '7', info());
  await resolveBridgeInNoteId(OWNER, '7', 'abcd');
  const result: TransactionResult = Object.create(null);
  Object.assign(result, {
    executedTransaction: () => ({
      id: () => ({ toHex: () => 'chain-tx' }),
      inputNotes: () => ({
        notes: () => [
          {
            note: () => ({
              id: () => ({ toString: () => '0xAbCd' }),
              metadata: () => ({ sender: () => 'sender', noteType: () => 0 }),
              assets: () => ({ fungibleAssets: () => [{ faucetId: () => 'faucet', amount: () => 12n }] })
            })
          }
        ]
      }),
      outputNotes: () => ({ notes: () => [] })
    }),
    serialize: () => new Uint8Array([1])
  });
  const hook = (_changes: object, key: unknown) => {
    if (key === KEY) throw new Error('linked write failed');
  };
  Repo.transactions.hook('updating', hook);
  const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await completeConsumeTransaction('consume', result);
  } finally {
    Repo.transactions.hook('updating').unsubscribe(hook);
    warning.mockRestore();
  }
  expect((await Repo.transactions.get('consume'))?.status).toBe(ITransactionStatus.Completed);
  expect((await Repo.transactions.get('consume'))?.extraInputs.bridgeIn.intentNonce).toBe('7');
  expect(mockRegistry.records).toHaveLength(1);
  await resolveBridgeInNoteId(OWNER, '7', 'abcd');
  expect((await Repo.transactions.get(KEY))?.extraInputs.phase).toBe('received');
  expect(mockRegistry.records).toEqual([]);
});

it('keeps an already-tagged old consume visible when a failed primary is retried', async () => {
  await Repo.transactions.bulkAdd([withdrawal({ phase: 'failed' }), consume()]);
  await registerPendingBridgeIn(OWNER, '7', info());
  await resolveBridgeInNoteId(OWNER, '7', 'abcd');
  await Repo.transactions.where({ id: KEY }).modify(row => {
    row.extraInputs = {
      ...row.extraInputs,
      phase: 'redeeming',
      submissionAttemptId: 'attempt-2',
      withdrawIntentNonce: undefined
    };
  });
  const old = await Repo.transactions.get('consume');
  if (!old) throw new Error('missing receipt');
  expect(await suppressedLinkedConsumeIds([old])).toEqual(new Set());
});
