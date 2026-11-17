import { bindTransferQuote } from 'lib/bridge/core/quote';
import { assertReviewedBridge, type ReviewedTransfer } from 'lib/bridge/core/review';
import { bridgeOperationOf } from 'lib/bridge/operation';
import { accounts, native, now } from 'lib/bridge/testing/fixtures';
import { reviewedCircleTransfer } from 'lib/bridge/testing/operation-fixtures';
import * as Repo from 'lib/miden/repo';
import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';

import { initiateUsdcxBurn } from './burn';
import { readUsdcxDestinationSnapshot } from './destination-status';

const mockOwnNotes = jest.fn(() => [{ id: () => ({ toString: () => 'burn-note-id' }) }]);
jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  const felts = { toFelts: () => [] };
  const builder = { withOwnOutputNotes: () => builder, withFeeConversionSalt: () => builder,
    build: () => ({ serialize: () => new Uint8Array([1,2,3]), expectedOutputOwnNotes: () => mockOwnNotes() }) };
  return { ...jest.requireActual('@miden-sdk/miden-sdk/lazy'),
    AccountId: { fromHex: (hex: string) => ({ toString: () => hex.toLowerCase() }) },
    RpcClient: jest.fn(() => ({ getAccountProof: async () => ({ getStorageSlotValue: () => undefined }), free: () => undefined })),
    NoteScript: { burn: () => ({}) }, FeltArray: jest.fn(),
    FungibleAsset: jest.fn(() => ({ vaultKey: () => felts, intoWord: () => felts })),
    NetworkAccountTarget: jest.fn(() => ({ toAttachment: () => ({}) })),
    Note: { withAttachments: () => ({}) }, NoteArray: jest.fn(), NoteAssets: jest.fn(),
    NoteAttachment: { fromWords: () => ({}) }, NoteAttachmentScheme: jest.fn(),
    NoteExecutionHint: { always: () => ({}) }, NoteMetadata: jest.fn(),
    NoteRecipient: { fromScript: () => ({}) }, NoteStorage: jest.fn(), NoteTag: jest.fn(),
    TransactionRequestBuilder: jest.fn(() => builder), Word: jest.fn()
  };
});
jest.mock('lib/miden/sdk/helpers', () => ({
  ...jest.requireActual('lib/miden/sdk/helpers'),
  getBech32AddressFromAccountId: (id: { toString: () => string }) => id.toString(), randomFeeSalt: () => ({})
}));
jest.mock('lib/miden/back/miden-client-proxy', () => ({ midenClientProxy: {} }));
jest.mock('lib/miden/activity/notes', () => ({ queueNoteImport: jest.fn() }));
jest.mock('lib/miden/guardian/account', () => ({ resolveGuardianEndpoint: jest.fn() }));
jest.mock('lib/store', () => ({ getIntercom: jest.fn() }));
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetId: async () => jest.requireActual('lib/bridge/testing/fixtures').native.faucetId,
  getNativeAssetIdSync: () => jest.requireActual('lib/bridge/testing/fixtures').native.faucetId
}));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'), getActiveOverride: () => null,
  getEffectiveNetworkName: () => 'testnet', getEffectiveRpcUrl: jest.fn(() => 'https://wallet-rpc.example/private')
}));
jest.mock('lib/remote-config/runtime', () => ({ getBridgeConfigSnapshot: () =>
  jest.requireActual('lib/bridge/testing/fixtures').referenceSnapshot('testnet') }));
jest.mock('lib/usdcx/destination-status', () => ({ readUsdcxDestinationSnapshot: jest.fn() }));

let live: ReviewedTransfer;
function input() {
  const incoming = reviewedCircleTransfer();
  const route = { ...incoming.route, mode: 'send', source: incoming.route.destination, destination: incoming.route.source } satisfies ReviewedTransfer['route'];
  const review = { route, amount: '6', accounts, quote: bindTransferQuote({ route, amount: '6', ...accounts }, {
    kind: 'withdrawal', received: '5.9', fee: '0.1', validity: { kind: 'time', expiresAt: now + 60000 }
  }) };
  live = structuredClone(review);
  assertReviewedBridge(review, live, now);
  return { senderPublicKey: accounts.midenAccount, faucetId: native.faucetId, amount: 6000000n,
    destinationAddress: accounts.evmAddress, destinationChainId: 11155111,
    operation: { operationId: 'circle-native', review }, checks: { readCurrent: async () => live, now: () => now } };
}
beforeEach(async () => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(now);
  jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://wallet-rpc.example/private');
  jest.mocked(readUsdcxDestinationSnapshot).mockResolvedValue({ balance: '0', blockNumber: '100' });
  await Repo.transactions.clear();
});
afterEach(() => jest.restoreAllMocks());

it('queues the exact burn through real admission with note-bound native source and payout snapshot', async () => {
  const id = await initiateUsdcxBurn(input());
  const row = await Repo.transactions.get(id);
  expect(row?.type).toBe('bridged-send');
  expect(row?.amount).toBe(6000000n);
  expect(row?.approvedOutputNoteIds).toEqual(['burn-note-id']);
  expect(row?.extraInputs.usdcxBurn?.phase).toBe('pending');
  expect(row?.extraInputs.usdcxBurn?.destinationBalanceBefore).toEqual({ balance: '0', blockNumber: '100' });
});
it('coalesces an original reviewed burn instead of admitting a second native source', async () => {
  const request = input();
  const first = await initiateUsdcxBurn(request);
  const second = await initiateUsdcxBurn(request);
  expect(second).toBe(first);
  expect(await Repo.transactions.count()).toBe(1);
  const row = await Repo.transactions.get(first);
  expect(bridgeOperationOf(row!)?.operationId).toBe('circle-native');
});
it('refuses RPC departure during the final payout snapshot read, not adopting a new native scope', async () => {
  jest.mocked(readUsdcxDestinationSnapshot).mockImplementationOnce(async () => {
    jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://other.example/private');
    return { balance: '0', blockNumber: '100' };
  });
  await expect(initiateUsdcxBurn(input())).rejects.toThrow();
  expect(await Repo.transactions.count()).toBe(0);
});
it('refuses live reviewed amount departure during the payout snapshot read', async () => {
  jest.mocked(readUsdcxDestinationSnapshot).mockImplementationOnce(async () => {
    live.amount = '7';
    return { balance: '0', blockNumber: '100' };
  });
  await expect(initiateUsdcxBurn(input())).rejects.toThrow();
  expect(await Repo.transactions.count()).toBe(0);
});
it('refuses a native actual amount that differs from the owned review', async () => {
  await expect(initiateUsdcxBurn({ ...input(), amount: 7000000n })).rejects.toThrow();
  expect(await Repo.transactions.count()).toBe(0);
});
