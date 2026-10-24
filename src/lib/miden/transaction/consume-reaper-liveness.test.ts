// The stuck-consume reaper spares a consume only while this realm's attempt for it is still running: it reads the
// attempt `generateTransactionsLoop` opens and closes, not the realm's lifetime record of rows it started.
import * as Repo from 'lib/miden/repo';

import { beginAttemptInThisRealm, endAttemptInThisRealm, verifyStuckTransactionsFromNode } from './cancel';
import { generateTransaction, generateTransactionsLoop } from './index';
import { OperationAbortedError } from '../back/offscreen-codec';
import { ITransaction, ITransactionStatus } from '../db/types';

const mockConsumeNoteId = jest.fn();
const mockGetInputNoteDetails = jest.fn();
const mockDispatchGuardianPipeline = jest.fn();

// The offscreen leaf passes its submit gate (#1644) before a submit, so a dispatch that resolves, or fails after the
// gate, opens it as the real leaf does; one tagged as failing before its submit never reaches it.
const mockLeafThroughGate = async (...a: unknown[]): Promise<unknown> => {
  const gate = a[6] as ((evidence?: unknown) => Promise<boolean>) | undefined;
  const { hasErrorBeforeSubmit } = jest.requireActual('../sdk/sdk-error-code');
  try {
    const result = await mockDispatchGuardianPipeline(...a);
    await gate?.();
    return result;
  } catch (error) {
    if (!hasErrorBeforeSubmit(error)) await gate?.();
    throw error;
  }
};
jest.mock('../back/miden-client-proxy', () => ({
  dispatchGuardianPipeline: (...a: unknown[]) => mockLeafThroughGate(...a),
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
const mockService = {
  guardianEndpoint: 'https://guardian.test',
  priorCandidateState: jest.fn(async () => 'settled'),
  createConsumeNotesProposal: jest.fn(async () => ({ id: 'prop', nonce: 7 })),
  signAndCreateTransactionRequest: jest.fn(async () => ({
    serialize: () => new Uint8Array([1]),
    authArg: () => undefined
  })),
  abandonCandidate: jest.fn(async () => {}),
  sync: jest.fn(async () => {})
};
jest.mock('lib/miden/front/guardian-manager', () => ({
  isGuardianAccount: () => mockIsGuardianAccount(),
  getOrCreateMultisigService: async () => mockService,
  clearGuardianServiceFor: jest.fn()
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
