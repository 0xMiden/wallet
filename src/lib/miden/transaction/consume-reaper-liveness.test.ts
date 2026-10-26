// The stuck-consume reaper spares a consume only while this realm's attempt for it is still running: it reads the
// attempt `generateTransactionsLoop` opens and closes, not the realm's lifetime record of rows it started.
import type { TransactionResult } from '@miden-sdk/miden-sdk/lazy';

import * as Repo from 'lib/miden/repo';

import { beginAttemptInThisRealm, endAttemptInThisRealm, verifyStuckTransactionsFromNode } from './cancel';
import { waitForTransactionCompletion } from './helper';
import { generateTransaction, generateTransactionsLoop } from './index';
import { OperationAbortedError } from '../back/offscreen-codec';
import { ITransaction, ITransactionStatus } from '../db/types';

const mockDeserializeResult = jest.fn();
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  ...jest.requireActual('@miden-sdk/miden-sdk/lazy'),
  TransactionResult: { deserialize: (bytes: Uint8Array) => mockDeserializeResult(bytes) }
}));

const mockConsumeNoteId = jest.fn();
const mockGetInputNoteDetails = jest.fn();
jest.mock('../back/miden-client-proxy', () => ({
  midenClientProxy: {
    syncState: jest.fn(async () => {}),
    consumeNoteId: (...a: unknown[]) => mockConsumeNoteId(...a),
    getInputNoteDetails: (...a: unknown[]) => mockGetInputNoteDetails(...a)
  }
}));
jest.mock('../back/offscreen-prover', () => ({ isOffscreenAvailable: () => true }));
let mockHold: object | null = null;
jest.mock('lib/miden/sdk/miden-client', () => jest.requireMock('../sdk/miden-client'));
jest.mock('../sdk/miden-client', () => ({
  getMidenClient: async () => ({ syncState: async () => {} }),
  withWasmClientLock: async <T>(fn: (hold: object) => Promise<T>) => {
    const hold = {};
    mockHold = hold;
    try {
      return await fn(hold);
    } finally {
      if (mockHold === hold) mockHold = null;
    }
  },
  getCurrentWasmLockHold: () => mockHold,
  assertWasmHoldCurrent: () => {},
  withWasmLockWatchdogPaused: async <T>(fn: () => Promise<T>) => fn()
}));
const mockIsGuardianAccount = jest.fn(async () => false);
jest.mock('lib/miden/front/guardian-manager', () => ({
  isGuardianAccount: () => mockIsGuardianAccount()
}));
jest.mock('../activity/notes', () => ({ importAllNotes: jest.fn(), queueNoteImport: jest.fn() }));
jest.mock('lib/miden-chain/native-asset', () => ({
  ...jest.requireActual('lib/miden-chain/native-asset'),
  getNativeAssetId: async () => 'usdcx-faucet'
}));
jest.mock('lib/miden/sdk/helpers', () => ({
  ...jest.requireActual('lib/miden/sdk/helpers'),
  getBech32AddressFromAccountId: (id: string) => id,
  sameWalletAccountId: (a: string, b: string) => a.split('_')[0] === b.split('_')[0]
}));
jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () => ({}),
  initBridgeConfig: async () => ({})
}));
jest.mock('lib/telemetry/report-operation', () => ({ reportOperation: jest.fn(), reportProve: jest.fn() }));
jest.mock('lib/platform', () => ({
  ...jest.requireActual('lib/platform'),
  isMobile: () => false,
  isExtension: () => true
}));
jest.mock('lib/intercom', () => ({ getIntercom: () => ({ broadcast: jest.fn(), request: jest.fn() }) }));
jest.mock('lib/store', () => ({
  useWalletStore: { getState: () => ({ accounts: [], setLastCompletedTxHash: jest.fn() }) }
}));
jest.mock('../back/background-notification', () => ({
  notifyBackgroundTransactionFailed: jest.fn(),
  notifyBackgroundTransactionNotConfirmed: jest.fn()
}));

const NOW = Math.floor(Date.now() / 1000);
const signCallback = jest.fn(async () => new Uint8Array([1]));
const provider = {
  getAccounts: async () => [],
  getPublicKeyForCommitment: async () => 'pk',
  signWord: async () => 'sig'
};

const queuedConsume = (): ITransaction => ({
  id: 'consume',
  type: 'consume',
  accountId: 'account',
  noteId: 'note',
  noteIds: ['note'],
  secondaryAccountId: 'sender',
  faucetId: 'faucet',
  amount: 1n,
  status: ITransactionStatus.Queued,
  initiatedAt: NOW,
  displayIcon: 'RECEIVE'
});

const status = async () => (await Repo.transactions.get('consume'))?.status;
const pastGraceWindow = () => Repo.transactions.update('consume', { processingStartedAt: NOW - 120 });
const note = (state: string) => [{ state }];

beforeEach(async () => {
  jest.clearAllMocks();
  mockIsGuardianAccount.mockResolvedValue(false);
  mockGetInputNoteDetails.mockResolvedValue(note('Committed'));
  delete process.env.MIDEN_USE_OFFSCREEN_CLIENT;
  await Repo.transactions.clear();
});

it('spares a consume the loop is still running past the grace window, then fails it once the loop is done', async () => {
  await Repo.transactions.put(queuedConsume());
  let duringPipeline: ITransactionStatus | undefined;
  let duringHandOff: ITransactionStatus | undefined;
  mockConsumeNoteId.mockImplementation(async () => {
    await pastGraceWindow();
    await verifyStuckTransactionsFromNode();
    duringPipeline = await status();
    mockGetInputNoteDetails.mockImplementationOnce(async () => {
      mockGetInputNoteDetails.mockResolvedValueOnce(note('Committed'));
      await verifyStuckTransactionsFromNode();
      duringHandOff = await status();
      return note('ProcessingAuthenticated');
    });
    throw new OperationAbortedError('op-kill', 'deadline');
  });

  await generateTransactionsLoop(signCallback, false, provider);

  expect(duringPipeline).toBe(ITransactionStatus.GeneratingTransaction);
  expect(duringHandOff).toBe(ITransactionStatus.GeneratingTransaction);
  expect(await status()).toBe(ITransactionStatus.GeneratingTransaction);

  mockGetInputNoteDetails.mockResolvedValue(note('Committed'));
  expect(await verifyStuckTransactionsFromNode()).toBe(1);
  expect(await status()).toBe(ITransactionStatus.Failed);
});

it('fails a consume whose direct generateTransaction call has thrown, once the grace window passes', async () => {
  await Repo.transactions.put(queuedConsume());
  mockConsumeNoteId.mockImplementation(async () => {
    await pastGraceWindow();
    throw new OperationAbortedError('op-kill', 'deadline');
  });

  await expect(generateTransaction(queuedConsume(), signCallback, false, provider)).rejects.toThrow('op-kill');
  expect(await status()).toBe(ITransactionStatus.GeneratingTransaction);

  expect(await verifyStuckTransactionsFromNode()).toBe(1);
  expect(await status()).toBe(ITransactionStatus.Failed);
});

it.each(['ConsumedAuthenticatedLocal', 'ConsumedUnauthenticatedLocal'])(
  'keeps the live %s consume open until its real result reaches the dApp waiter',
  async state => {
    await Repo.transactions.put(queuedConsume());
    const bytes = new Uint8Array([7, 8, 9]);
    const result: TransactionResult = Object.create(null);
    Object.assign(result, {
      executedTransaction: () => ({
        id: () => ({ toHex: () => 'real-chain-tx' }),
        inputNotes: () => ({
          notes: () => [
            {
              note: () => ({
                id: () => ({ toString: () => 'note' }),
                metadata: () => ({ sender: () => 'sender', noteType: () => 0 }),
                assets: () => ({ fungibleAssets: () => [{ faucetId: () => 'faucet', amount: () => 1n }] })
              })
            }
          ]
        }),
        outputNotes: () => ({ notes: () => [{ intoFull: () => ({ serialize: () => new Uint8Array([4, 5, 6]) }) }] })
      }),
      serialize: () => bytes
    });
    mockDeserializeResult.mockReturnValue(result);
    let reaped: number | undefined;
    let duringPipeline: ITransactionStatus | undefined;
    mockConsumeNoteId.mockImplementation(async () => {
      await pastGraceWindow();
      mockGetInputNoteDetails.mockResolvedValue(note(state));
      reaped = await verifyStuckTransactionsFromNode();
      duringPipeline = await status();
      return result;
    });
    const waiting = waitForTransactionCompletion('consume');

    await generateTransactionsLoop(signCallback, false, provider);

    await expect(waiting).resolves.toEqual({ txHash: 'real-chain-tx', outputNotes: ['BAUG'] });
    expect(reaped).toBe(0);
    expect(duringPipeline).toBe(ITransactionStatus.GeneratingTransaction);
    expect(await Repo.transactions.get('consume')).toMatchObject({
      status: ITransactionStatus.Completed,
      transactionId: 'real-chain-tx',
      resultBytes: bytes
    });
  }
);

it('recovers a locally landed consume once its abandoned attempt is no longer live', async () => {
  await Repo.transactions.put({ ...queuedConsume(), status: ITransactionStatus.GeneratingTransaction });
  mockGetInputNoteDetails.mockResolvedValue(note('ConsumedAuthenticatedLocal'));
  beginAttemptInThisRealm('consume');
  endAttemptInThisRealm('consume');

  expect(await verifyStuckTransactionsFromNode()).toBe(1);
  expect(await status()).toBe(ITransactionStatus.Completed);
});

it('still fails an invalid note immediately while its consume attempt is live', async () => {
  await Repo.transactions.put({ ...queuedConsume(), status: ITransactionStatus.GeneratingTransaction });
  mockGetInputNoteDetails.mockResolvedValue(note('Invalid'));
  beginAttemptInThisRealm('consume');
  try {
    expect(await verifyStuckTransactionsFromNode()).toBe(1);
    expect(await status()).toBe(ITransactionStatus.Failed);
  } finally {
    endAttemptInThisRealm('consume');
  }
});

describe('an attempt the sync stage never began', () => {
  const syncSpare = (): ITransaction => ({ ...queuedConsume(), id: 'sync-spare' });
  const syncSpareRow = () => Repo.transactions.get('sync-spare');
  const reapedAfterSyncFailure = async () => {
    await Repo.transactions.update('sync-spare', {
      status: ITransactionStatus.GeneratingTransaction,
      processingStartedAt: Math.floor(Date.now() / 1000) - 120
    });
    return verifyStuckTransactionsFromNode();
  };

  it('leaves another open attempt for the same id open when the loop fails at sync', async () => {
    await Repo.transactions.put(syncSpare());
    beginAttemptInThisRealm('sync-spare');
    try {
      jest
        .requireMock('../back/miden-client-proxy')
        .midenClientProxy.syncState.mockRejectedValueOnce(new Error('sync down'));
      await expect(generateTransactionsLoop(signCallback, false, provider)).resolves.toBe(false);
      expect((await syncSpareRow())?.status).toBe(ITransactionStatus.Queued);
      expect((await syncSpareRow())?.stage).toBe('syncing');

      expect(await reapedAfterSyncFailure()).toBe(0);
      expect((await syncSpareRow())?.status).toBe(ITransactionStatus.GeneratingTransaction);
    } finally {
      endAttemptInThisRealm('sync-spare');
    }
  });

  it('leaves another open attempt for the same id open when a direct generateTransaction fails at sync', async () => {
    await Repo.transactions.put(syncSpare());
    beginAttemptInThisRealm('sync-spare');
    try {
      jest
        .requireMock('../back/miden-client-proxy')
        .midenClientProxy.syncState.mockRejectedValueOnce(new Error('sync down'));
      await expect(generateTransaction(syncSpare(), signCallback, false, provider)).rejects.toThrow('sync down');
      expect((await syncSpareRow())?.status).toBe(ITransactionStatus.Queued);
      expect((await syncSpareRow())?.stage).toBe('syncing');

      expect(await reapedAfterSyncFailure()).toBe(0);
      expect((await syncSpareRow())?.status).toBe(ITransactionStatus.GeneratingTransaction);
    } finally {
      endAttemptInThisRealm('sync-spare');
    }
  });
});
