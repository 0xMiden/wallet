// A claim that another device of the same account makes (multi-device): the loop removes the row, or keeps it in the
// queue while the Guardian's history does not name its note yet. Real store and real loop arms; the client and the
// Guardian service are stood in for.
import { InputNoteState } from '@miden-sdk/miden-sdk/lazy';

import { ClaimStartedElsewhereError } from 'lib/miden/guardian/claims-elsewhere';
import * as Repo from 'lib/miden/repo';

import { CLAIMED_ELSEWHERE_CHECK_SEC } from './claim-made-elsewhere';
import { generateTransaction } from './index';
import { ITransaction, ITransactionStatus } from '../db/types';

const mockGetInputNoteDetails = jest.fn();
jest.mock('../back/miden-client-proxy', () => ({
  dispatchGuardianPipeline: jest.fn(),
  midenClientProxy: {
    syncState: jest.fn(async () => {}),
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

const mockCreateConsumeNotesProposal = jest.fn();
const mockNotesClaimedByAccount = jest.fn();
const mockSign = jest.fn();
const mockService = {
  guardianEndpoint: 'https://guardian.test',
  priorCandidateState: jest.fn(async () => 'settled'),
  createConsumeNotesProposal: (...a: unknown[]) => mockCreateConsumeNotesProposal(...a),
  notesClaimedByAccount: () => mockNotesClaimedByAccount(),
  signAndCreateTransactionRequest: (...a: unknown[]) => mockSign(...a),
  abandonCandidate: jest.fn(async () => {}),
  sync: jest.fn(async () => {})
};
jest.mock('lib/miden/front/guardian-manager', () => ({
  isGuardianAccount: async () => true,
  getOrCreateMultisigService: async () => mockService,
  clearGuardianServiceFor: jest.fn()
}));
jest.mock('../activity/notes', () => ({ importAllNotes: jest.fn(), queueNoteImport: jest.fn() }));
jest.mock('./proposal-effect-guard', () => ({
  assertProposalEffectApproved: async () => {},
  isEffectChecked: () => false
}));
jest.mock('lib/miden-chain/native-asset', () => ({
  ...jest.requireActual('lib/miden-chain/native-asset'),
  getNativeAssetId: async () => 'native-faucet'
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

const claim = (overrides: Partial<ITransaction> = {}): ITransaction => ({
  id: 'claim',
  type: 'consume',
  accountId: 'account',
  noteId: '0xNOTE',
  noteIds: ['0xNOTE'],
  faucetId: 'native-faucet',
  amount: 5n,
  status: ITransactionStatus.Queued,
  initiatedAt: NOW,
  displayIcon: 'RECEIVE',
  consumeEntryPoint: 'auto_consume',
  ...overrides
});

/** The multisig client's refusal of a note it cannot authenticate, as it reaches the loop. */
const notAuthenticated = () =>
  Object.assign(new Error('consume_notes: note 0xNOTE could not be authenticated'), {
    name: 'ConsumeNoteNotAuthenticatedError',
    code: 'consume_notes_note_not_authenticated'
  });

const run = async (row: ITransaction) => {
  await Repo.transactions.put(row);
  await generateTransaction(row, signCallback, false, provider);
  return Repo.transactions.get(row.id);
};

beforeEach(async () => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockGetInputNoteDetails.mockResolvedValue([{ noteId: '0xNOTE', state: InputNoteState.ConsumedExternal }]);
  mockNotesClaimedByAccount.mockResolvedValue(new Set(['note']));
  await Repo.transactions.clear();
});
afterEach(() => jest.restoreAllMocks());

it('removes a claim that another device already started, and proposes nothing', async () => {
  mockCreateConsumeNotesProposal.mockRejectedValue(new ClaimStartedElsewhereError(['0xNOTE']));

  expect(await run(claim())).toBeUndefined();
  expect(mockCreateConsumeNotesProposal).toHaveBeenCalledWith(['0xNOTE'], { stopIfStartedElsewhere: true });
  expect(mockSign).not.toHaveBeenCalled();
});

it('removes a claim whose consumed note the Guardian history names as an input of this account', async () => {
  mockCreateConsumeNotesProposal.mockRejectedValue(notAuthenticated());

  expect(await run(claim())).toBeUndefined();
});

it('keeps a claim in the queue while the Guardian history does not name its consumed note yet', async () => {
  mockCreateConsumeNotesProposal.mockRejectedValue(notAuthenticated());
  mockNotesClaimedByAccount.mockResolvedValue(new Set(['another-note']));

  const row = await run(claim());

  expect(row).toMatchObject({
    status: ITransactionStatus.Queued,
    lastDeferral: 'guardian_backpressure',
    guardianBusy: true
  });
  expect(row?.claimedElsewhereCheckUntil).toBeGreaterThanOrEqual(NOW + CLAIMED_ELSEWHERE_CHECK_SEC);
  expect(row?.nextEligibleAt).toBeGreaterThan(NOW);
});

it('keeps the first deadline on a later wait, and waits again when the Guardian gave no answer', async () => {
  mockCreateConsumeNotesProposal.mockRejectedValue(notAuthenticated());
  mockNotesClaimedByAccount.mockResolvedValue(undefined);

  const row = await run(claim({ claimedElsewhereCheckUntil: NOW + 60 }));

  expect(row).toMatchObject({ status: ITransactionStatus.Queued, claimedElsewhereCheckUntil: NOW + 60 });
});

it('fails the claim with its own error when the wait is over', async () => {
  mockCreateConsumeNotesProposal.mockRejectedValue(notAuthenticated());
  mockNotesClaimedByAccount.mockResolvedValue(new Set());

  const row = await run(claim({ claimedElsewhereCheckUntil: NOW + 5 }));

  expect(row?.status).toBe(ITransactionStatus.Failed);
  expect(`${row?.error} ${row?.rawError}`).toContain('could not be authenticated');
});

it('fails the claim when the local store does not show its note consumed', async () => {
  mockCreateConsumeNotesProposal.mockRejectedValue(notAuthenticated());
  mockGetInputNoteDetails.mockResolvedValue([{ noteId: '0xNOTE', state: InputNoteState.Committed }]);

  const row = await run(claim());

  expect(row?.status).toBe(ITransactionStatus.Failed);
  expect(mockNotesClaimedByAccount).not.toHaveBeenCalled();
});

it('fails the claim when the note read fails', async () => {
  mockCreateConsumeNotesProposal.mockRejectedValue(notAuthenticated());
  mockGetInputNoteDetails.mockRejectedValue(new Error('store read failed'));

  expect((await run(claim()))?.status).toBe(ITransactionStatus.Failed);
});

it('never removes the claim of a dApp, which waits for the row, and does not gate it', async () => {
  mockCreateConsumeNotesProposal.mockRejectedValue(notAuthenticated());

  const row = await run(claim({ consumeEntryPoint: 'dapp' }));

  expect(row?.status).toBe(ITransactionStatus.Failed);
  expect(mockCreateConsumeNotesProposal).toHaveBeenCalledWith(['0xNOTE']);
  expect(mockGetInputNoteDetails).not.toHaveBeenCalled();
});

it('fails another proposal failure as before', async () => {
  mockCreateConsumeNotesProposal.mockRejectedValue(new Error('failed to build transaction request: boom'));

  const row = await run(claim());

  expect(row?.status).toBe(ITransactionStatus.Failed);
  expect(mockGetInputNoteDetails).not.toHaveBeenCalled();
});
