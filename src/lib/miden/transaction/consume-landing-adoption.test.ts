// Every path that completes a consume without a TransactionResult must still land the USDCx deposit its note was
// minted for. Real store, real adopter and real matchers; the client, the node and the Guardian are stood in for.
import * as Repo from 'lib/miden/repo';

import { verifyStuckTransactionsFromNode } from './cancel';
import { generateTransaction, generateTransactionsLoop } from './index';
import { NodeReads } from './reconcile-reads';
import { judgeAndWrite } from './reconcile-unconfirmed';
import { OperationAbortedError } from '../back/offscreen-codec';
import { ITransaction, ITransactionStatus } from '../db/types';

const mockConsumeNoteId = jest.fn();
const mockGetInputNoteDetails = jest.fn();
const mockDispatchGuardianPipeline = jest.fn();

// The offscreen leaf passes its submit gate (#1644) before a submit, so a dispatch that resolves, or fails after the
// gate, opens it as the real leaf does; one tagged as failing before its submit never reaches it.
const mockLeafThroughGate = async (...a: unknown[]): Promise<unknown> => {
  const callback = a[6];
  const gate = typeof callback === 'function' ? callback : undefined;
  const { hasErrorBeforeSubmit } = jest.requireActual('../sdk/sdk-error-code');
  try {
    const result = await mockDispatchGuardianPipeline(...a);
    await gate?.(undefined, { requestBytes: new Uint8Array([1]), notes: [] });
    return result;
  } catch (error) {
    if (!hasErrorBeforeSubmit(error)) await gate?.(undefined, { requestBytes: new Uint8Array([1]), notes: [] });
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
const MINT = 1_000_000n;
const hex = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const signCallback = jest.fn(async () => new Uint8Array([1]));
const provider = {
  getAccounts: async () => [],
  getPublicKeyForCommitment: async () => 'pk',
  signWord: async () => 'sig'
};

const addDeposit = () =>
  Repo.transactions.add({
    id: 'deposit',
    type: 'bridged-receive',
    accountId: 'account',
    amount: MINT,
    faucetId: 'usdcx-faucet',
    status: ITransactionStatus.Completed,
    displayIcon: 'RECEIVE',
    initiatedAt: NOW - 60,
    extraInputs: {
      provider: 'usdcx',
      phase: 'ready',
      sourceAddress: '0xsource',
      sourceAmount: '1',
      sourceSymbol: 'USDC',
      evmTxHash: hex(5)
    }
  });

/** The consume of one USDCx mint, as `ConsumeTransaction` queues it. */
const mintConsume = (overrides: Partial<ITransaction> = {}): ITransaction => ({
  id: 'consume',
  type: 'consume',
  accountId: 'account',
  noteId: 'mint-note',
  noteIds: ['mint-note'],
  secondaryAccountId: 'usdcx-faucet',
  faucetId: 'usdcx-faucet',
  amount: MINT,
  consumedNotes: [{ id: 'mint-note', senderAddress: 'usdcx-faucet', faucetId: 'usdcx-faucet', amount: MINT }],
  status: ITransactionStatus.Queued,
  initiatedAt: NOW,
  displayIcon: 'RECEIVE',
  ...overrides
});

const deposit = () => Repo.transactions.get('deposit');
const consume = () => Repo.transactions.get('consume');

beforeEach(async () => {
  jest.clearAllMocks();
  mockIsGuardianAccount.mockResolvedValue(false);
  mockGetInputNoteDetails.mockResolvedValue([]);
  delete process.env.MIDEN_USE_OFFSCREEN_CLIENT;
  await Repo.transactions.clear();
  await addDeposit();
});

/** What a landing left: the consume's status and kept result, and the deposit's phase and note. */
const outcome = async () => {
  const [row, tracker] = [await consume(), await deposit()];
  return {
    status: row?.status,
    resultBytes: row?.resultBytes,
    phase: tracker?.extraInputs?.phase,
    midenNoteId: tracker?.extraInputs?.midenNoteId
  };
};
const LANDED = { status: ITransactionStatus.Completed, phase: 'received', midenNoteId: 'mint-note' };

it('the unconfirmed reconciler landing a consume lands its deposit', async () => {
  await Repo.transactions.put(
    mintConsume({
      status: ITransactionStatus.Unconfirmed,
      completedAt: NOW - 30,
      mayHaveSubmitted: true,
      submitEvidence: [
        {
          attemptId: 'a1',
          capturedAt: NOW - 30,
          source: 'stage',
          transactionId: hex(2),
          initialCommitment: hex(10),
          finalCommitment: hex(11),
          initialNonce: '5',
          outputNoteIds: [],
          nullifiers: [],
          refBlock: 100,
          refBlockCommitment: hex(1),
          expirationBlock: 700
        }
      ]
    })
  );
  const node: NodeReads = {
    blockCommitment: async () => hex(1),
    account: async () => ({ ok: true, state: { blockNum: 150, commitment: hex(11) } }),
    noteInclusions: async () => new Map(),
    nullifierHeight: async () => null
  };

  expect((await judgeAndWrite('consume', { node, nowSec: NOW, cadenceMs: 3_000 })).kind).toBe('landed');

  expect(await outcome()).toEqual(LANDED);
});

it('the stuck-consume reaper completing a consume lands its deposit', async () => {
  await Repo.transactions.put(
    mintConsume({ status: ITransactionStatus.GeneratingTransaction, processingStartedAt: NOW - 30 })
  );
  mockGetInputNoteDetails.mockResolvedValue([{ state: 'ConsumedAuthenticatedLocal' }]);

  await verifyStuckTransactionsFromNode();

  expect(await outcome()).toEqual(LANDED);
});

it('a killed consume the node shows landed lands its deposit', async () => {
  await Repo.transactions.put(mintConsume());
  mockConsumeNoteId.mockRejectedValue(new OperationAbortedError('op-kill', 'deadline'));
  mockGetInputNoteDetails.mockResolvedValue([{ state: 'ConsumedAuthenticatedLocal' }]);

  await generateTransactionsLoop(signCallback, false, provider);

  expect(await outcome()).toEqual(LANDED);
});

it('a consume whose submit landed but whose local apply failed lands its deposit', async () => {
  await Repo.transactions.put(mintConsume());
  const applyFailed = Object.assign(new Error('local apply failed after submit'), {
    errorCode: 'ApplyTransactionAfterSubmitFailed',
    landed: { transactionId: hex(2) }
  });
  mockConsumeNoteId.mockRejectedValue(applyFailed);

  await generateTransactionsLoop(signCallback, false, provider);

  expect(await outcome()).toEqual(LANDED);
});

it('a Guardian consume whose submit landed but whose local apply failed lands its deposit', async () => {
  process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
  mockIsGuardianAccount.mockResolvedValue(true);
  await Repo.transactions.put(mintConsume({ status: ITransactionStatus.GeneratingTransaction }));
  const applyFailed = Object.assign(new Error('local apply failed after submit'), {
    errorCode: 'ApplyTransactionAfterSubmitFailed',
    landed: { transactionId: hex(2) }
  });
  mockDispatchGuardianPipeline.mockRejectedValue(applyFailed);

  await generateTransaction(
    mintConsume({ status: ITransactionStatus.GeneratingTransaction }),
    signCallback,
    false,
    provider
  );

  expect(await outcome()).toEqual(LANDED);
});

jest.mock('../recovery/checkpoint', () => ({
  checkpointTransactionRecovery: jest.fn(async (_id: string, capture: unknown) => {
    jest.requireActual<typeof import('../recovery/capture')>('../recovery/capture').decodeRecoveryCapture(capture);
    jest.requireActual<typeof import('../storage-health')>('../storage-health').assertStorageHealthy();
  })
}));

jest.mock('lib/miden/recovery/receipt-writer', () => ({
  checkpointProviderReceipt: async () => {
    jest.requireActual<typeof import('../storage-health')>('../storage-health').assertStorageHealthy();
  }
}));
