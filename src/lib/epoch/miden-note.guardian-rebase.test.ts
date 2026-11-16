import Dexie from 'dexie';
import { parseUnits } from 'viem';

import { assertReviewedBridge } from 'lib/bridge/core/review';
import { accounts, now, referenceSnapshot } from 'lib/bridge/testing/fixtures';
import { reviewedErc20Transfer } from 'lib/bridge/testing/operation-fixtures';
import { ITransactionStatus } from 'lib/miden/db/types';
import { MultisigService } from 'lib/miden/guardian';
import { proposeRebased } from 'lib/miden/guardian/rebased-proposal';
import * as Repo from 'lib/miden/repo';
import { bindFeeFaucetClientScope } from 'lib/miden/sdk/sync-and-record-fee-faucet';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';

import { createBridgeP2IDENote, type CreateBridgeP2IDENoteArgs } from './miden-note';

const ORIGINAL_BYTES = new Uint8Array([81, 82]);
const REBASED_BYTES = new Uint8Array([91, 92]);
const COMMITMENT = `0x${'5e'.repeat(32)}`;
const mockOwnNotes = [{ id: 'original-note' }];
const mockCreateProposal = jest.fn();
const mockWithOwnOutputNotes = jest.fn();
const mockWait = jest.fn();
let mockSnapshot: BridgeConfigSnapshot;
let mockCurrentHold: object | null = null;
const mockRawClient = {
  syncChain: async () => undefined,
  feeFaucetId: async () => ({ toString: () => '0x817edea77acc5d71616e493afecea3' }),
  accounts: { get: async () => ({ nonce: () => ({ asInt: () => 40n }) }) }
};

jest.mock('lib/miden/activity', () => ({
  initiateBridgedSendTransaction: (...args: unknown[]) =>
    Reflect.apply(jest.requireActual('lib/miden/transaction/initiate').initiateBridgedSendTransaction, undefined, args),
  requestSWTransactionProcessing: jest.fn(),
  startBackgroundTransactionProcessing: jest.fn(),
  waitForTransactionCompletion: (id: string) => mockWait(id)
}));
jest.mock('./collateral-note', () => ({
  buildEpochCollateralRequestBytes: async () => ({
    requestBytes: ORIGINAL_BYTES,
    reclaimHeight: 6000,
    noteId: 'original-note'
  })
}));
// Guardian's relative SDK imports must share these same boundary doubles and construction-scope map.
jest.mock('lib/miden/sdk/helpers', () => jest.requireMock('../miden/sdk/helpers'));
jest.mock('../miden/sdk/helpers', () => ({
  ...jest.requireActual('../miden/sdk/helpers'),
  accountRefToSdk: (value: string) => value,
  getBech32AddressFromAccountId: (value: string) => value,
  randomFeeSalt: () => ({}),
  feeAwareRequestBuilder: async () => {
    const builder = {
      withOwnOutputNotes: (notes: unknown) => {
        mockWithOwnOutputNotes(notes);
        return builder;
      },
      build: () => ({ serialize: () => REBASED_BYTES })
    };
    return builder;
  }
}));
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  ...jest.requireActual('../../../__mocks__/wasmMock.js'),
  TransactionRequest: {
    deserialize: () => ({ expectedOutputOwnNotes: () => mockOwnNotes, free: () => undefined })
  },
  NoteArray: function (notes: unknown) {
    return { notes };
  }
}));
jest.mock('@miden-sdk/miden-sdk', () => ({
  ...jest.requireActual('../../../__mocks__/wasmMock.js'),
  TransactionRequest: {
    deserialize: () => ({ expectedOutputOwnNotes: () => mockOwnNotes, free: () => undefined })
  },
  NoteArray: function (notes: unknown) {
    return { notes };
  }
}));
jest.mock('@openzeppelin/miden-multisig-client', () => ({
  ...jest.requireActual('@openzeppelin/miden-multisig-client'),
  executeForSummaryAtTip: async () => ({
    serialize: () => new Uint8Array([0xab]),
    toCommitment: () => ({ toHex: () => COMMITMENT, free: () => undefined }),
    free: () => undefined
  }),
  summaryBoundBlockNum: () => 5150
}));
jest.mock('lib/miden/sdk/sync-and-record-fee-faucet', () =>
  jest.requireActual('../miden/sdk/sync-and-record-fee-faucet')
);
jest.mock('lib/miden/sdk/miden-client', () => jest.requireMock('../miden/sdk/miden-client'));
jest.mock('../miden/sdk/miden-client', () => ({
  getMidenClient: async () => ({ client: mockRawClient }),
  getCurrentWasmLockHold: () => mockCurrentHold,
  assertWasmHoldCurrent: (hold: object) => {
    if (hold !== mockCurrentHold) throw new Error('WASM hold changed');
  },
  withWasmClientLock: async <T>(fn: (hold: object) => Promise<T>) => {
    const hold = {};
    mockCurrentHold = hold;
    try {
      return await fn(hold);
    } finally {
      mockCurrentHold = null;
    }
  }
}));
jest.mock('lib/miden/back/miden-client-proxy', () => ({ midenClientProxy: {} }));
jest.mock('lib/miden/activity/notes', () => ({ queueNoteImport: jest.fn() }));
jest.mock('lib/miden/guardian/account', () => ({ resolveGuardianEndpoint: jest.fn() }));
jest.mock('lib/store', () => ({ getIntercom: jest.fn() }));
jest.mock('lib/platform', () => ({ ...jest.requireActual('lib/platform'), isExtension: () => true }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getActiveOverride: () => null,
  getEffectiveNetworkName: () => 'testnet',
  getEffectiveRpcUrl: () => 'https://wallet-rpc.example/private'
}));
jest.mock('lib/remote-config/runtime', () =>
  jest
    .requireActual<typeof import('./testing/bridge-config')>('./testing/bridge-config')
    .remoteConfigRuntimeMock(() => mockSnapshot)
);

function noteInput(): CreateBridgeP2IDENoteArgs {
  const review = reviewedErc20Transfer('epoch', 'send');
  assertReviewedBridge(review, structuredClone(review), now);
  if (review.route.source.kind !== 'miden') throw new Error('Missing accepted native source');
  return {
    senderAccountId: accounts.midenAccount,
    faucetId: review.route.source.faucetId,
    amount: parseUnits(review.amount, review.route.source.decimals).toString(),
    allocatorId: accounts.midenAccount,
    recallBlocks: 5000,
    bindingAttachmentFelts: [1n, 2n],
    destinationAddress: accounts.evmAddress,
    destinationNetwork: 11155111,
    allocatorUrl: review.route.recovery.config['bridge-providers'].epoch.allocatorUrl,
    operation: { operationId: 'guardian-collateral', review },
    reviewedOutput: {
      minimumOutputBaseUnits: '1000000000000000000',
      outputTokenAddress: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
      outputTokenDecimals: 18,
      validity: { kind: 'time', expiresAt: now + 60000 }
    },
    deps: {
      signTransaction: async () => new Uint8Array(),
      guardianProvider: {
        getAccounts: async () => [],
        getPublicKeyForCommitment: async () => '',
        signWord: async () => ''
      }
    }
  };
}

beforeEach(async () => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(now);
  await Repo.transactions.clear();
  await Repo.spendingLimits.clear();
  mockSnapshot = referenceSnapshot('testnet');
  mockCurrentHold = null;
  bindFeeFaucetClientScope(mockRawClient, 'https://wallet-rpc.example/private|testnet');
  mockCreateProposal.mockResolvedValue({ id: COMMITMENT, nonce: 41 });
  mockWait.mockImplementation(async (id: string) => {
    await Repo.transactions.update(id, { status: ITransactionStatus.Completed, outputNoteIds: ['original-note'] });
    return { txHash: 'original-source-hash' };
  });
});
afterEach(() => jest.restoreAllMocks());

it('hands off a valid original owned note through real admission without a concurrent rebase', async () => {
  const result = await createBridgeP2IDENote(noteInput());
  expect(result).toEqual({ success: true, noteId: 'original-note', txId: expect.any(String) });
  const row = await Repo.transactions.get(result.txId!);
  expect(row?.extraInputs.bridgeOperation?.operationId).toBe('guardian-collateral');
  expect(row?.approvedOutputNoteIds).toEqual(['original-note']);
});

it('does not invent a fresh handoff fact from an older row current execution bytes', async () => {
  const transaction = Repo.db.transaction.bind(Repo.db);
  jest.spyOn(Repo.db, 'transaction').mockImplementationOnce((...args) => {
    const committed: unknown = Reflect.apply(transaction, Repo.db, args);
    return Dexie.Promise.resolve(committed).then(async value => {
      await Repo.transactions.toCollection().modify(row => {
        delete row.extraInputs.epochCollateralRequestBytes;
      });
      return value;
    });
  });
  expect(await createBridgeP2IDENote(noteInput())).toEqual({ success: false });
  const [row] = await Repo.transactions.toArray();
  expect(row?.requestBytes).toEqual(ORIGINAL_BYTES);
  expect(row?.extraInputs).not.toHaveProperty('epochCollateralRequestBytes');
  expect(await Repo.transactions.count()).toBe(1);
  expect(mockWait).not.toHaveBeenCalled();
});

it('keeps the winning collateral handoff after the real Guardian owner legitimately rebases its request', async () => {
  const multisig = {
    accountId: accounts.midenAccount,
    account: { nonce: () => ({ asInt: () => 40n }) },
    getEffectiveThreshold: () => 1,
    createProposal: (...args: unknown[]) => mockCreateProposal(...args)
  };
  const constructed: unknown = Reflect.construct(MultisigService, [multisig, {}, 'https://guardian.example']);
  if (!(constructed instanceof MultisigService)) throw new Error('Missing real Guardian service');
  const service = constructed;
  const transaction = Repo.db.transaction.bind(Repo.db);
  let rebasedId = '';
  jest.spyOn(Repo.db, 'transaction').mockImplementationOnce((...args) => {
    const committed: unknown = Reflect.apply(transaction, Repo.db, args);
    return Dexie.Promise.resolve(committed).then(async value => {
      expect(Dexie.currentTransaction).toBeFalsy();
      const [row] = await Repo.transactions.toArray();
      if (!row?.requestBytes) throw new Error('Missing real committed native admission');
      expect(row.extraInputs.bridgeOperation?.operationId).toBe('guardian-collateral');
      expect(row.extraInputs.epochCollateralRequestBytes).toEqual(ORIGINAL_BYTES);
      rebasedId = row.id;
      await proposeRebased(service, row, row.requestBytes, 'bridged_send', 180);
      return value;
    });
  });
  const result = await createBridgeP2IDENote(noteInput());
  const row = await Repo.transactions.get(rebasedId);
  expect(mockWithOwnOutputNotes).toHaveBeenCalledWith({ notes: [{ id: 'original-note' }] });
  expect(mockCreateProposal).toHaveBeenCalledWith(
    41,
    expect.any(String),
    expect.objectContaining({
      boundBlockNum: 5150,
      proposalType: 'custom',
      rawProposalType: 'bridged_send'
    })
  );
  expect(row?.requestBytes).toEqual(new Uint8Array([91, 92]));
  expect(row?.extraInputs.epochCollateralRequestBytes).toEqual(ORIGINAL_BYTES);
  expect(row?.approvedOutputNoteIds).toEqual(['original-note']);
  expect(row?.extraInputs.bridgeOperation?.operationId).toBe('guardian-collateral');
  expect(await Repo.transactions.count()).toBe(1);
  expect(result).toEqual({ success: true, noteId: 'original-note', txId: rebasedId });
});
