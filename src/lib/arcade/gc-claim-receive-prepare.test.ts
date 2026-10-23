import type { TxAssetView } from 'app/confirm/decode';

import type { GcClaimContext, GcClaimIssuanceEvidence } from './gc-claim-operation';
import { prepareGcReceipt } from './gc-claim-receive';
const mockSimulate = jest.fn();
const mockView = jest.fn();
const mockInputId = jest.fn();
const mockRunsHere = jest.fn(() => true);
const mockBuild = jest.fn((..._args: unknown[]) => ({ serialize: () => new Uint8Array([4]) }));
const word = `0x${'aa'.repeat(32)}`;
const RECEIPT = `0x${'bb'.repeat(32)}`;
const ACCOUNT = `0x${'11'.repeat(15)}`;
const NATIVE = `0x${'22'.repeat(15)}`;
const ISSUER = `0x${'33'.repeat(15)}`;
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  Note: {
    deserialize: () => {
      throw new Error('Proof-backed files are not raw Note bytes');
    }
  },
  NoteFile: {
    deserialize: () => ({
      note: () => ({
        id: () => ({ toString: () => RECEIPT }),
        recipient: () => ({ digest: () => ({ toHex: () => word }) })
      })
    })
  },
  TransactionSummary: {
    deserialize: () => ({
      inputNotes: () => ({ numNotes: () => 1, getNote: () => ({ id: () => ({ toString: () => mockInputId() }) }) })
    })
  }
}));
jest.mock('lib/miden/sdk/helpers', () => ({
  accountRefToSdk: (input: string) => ({ toString: () => input }),
  feeAwareRequestBuilder: async () => ({ preparedAuth: true }),
  randomFeeSalt: () => ({}),
  buildConsumeTransactionRequest: (...args: unknown[]) => mockBuild(...args)
}));
jest.mock('lib/miden/spending-limits/queue', () => ({ queueOutgoingTransaction: jest.fn() }));
jest.mock('lib/miden-chain/constants', () => ({ ensureSdkWasmReady: async () => undefined }));
jest.mock('lib/miden/helpers', () => ({ EXPIRATION_DELTA_BLOCKS: 100 }));
jest.mock('lib/miden/back/simulate-custom-tx', () => ({
  simulateCustomTransaction: (input: unknown) => mockSimulate(input)
}));
jest.mock('lib/miden/back/miden-client-proxy', () => ({ runsWasmInThisRealm: () => mockRunsHere() }));
jest.mock('lib/miden/sdk/miden-client', () => ({
  getMidenClient: async () => ({ client: {} }),
  withWasmClientLock: async (callback: (hold: object) => Promise<unknown>) => callback({}),
  assertWasmHoldCurrent: jest.fn()
}));
jest.mock('app/confirm/decode', () => ({ simulatedBytesToView: () => mockView() }));
const context: GcClaimContext = {
  network: 'testnet',
  genesisCommitment: word,
  accountId: ACCOUNT,
  issuerId: ISSUER,
  issuerCodeCommitment: word,
  nativeAssetId: NATIVE
};
const issuance: GcClaimIssuanceEvidence = {
  kind: 'issued',
  genesisCommitment: word,
  blockNumber: 1,
  blockCommitment: word,
  accountId: ACCOUNT,
  requestNoteId: word,
  requestNullifier: word,
  issuerId: ISSUER,
  receiptNoteId: RECEIPT,
  receiptRecipientCommitment: word,
  gcAmount: 10_000_000n,
  nativeRefund: 91n,
  issuerFee: 28n
};
beforeEach(() => {
  mockRunsHere.mockReturnValue(true);
  mockInputId.mockReturnValue(RECEIPT);
  mockSimulate.mockResolvedValue({ summaryBytes: 'AQ==', preparedRequestBytes: 'Bg==' });
  const view: TxAssetView = {
    account: ACCOUNT,
    incoming: [
      { faucetId: ISSUER, amount: 10_000_000n },
      { faucetId: NATIVE, amount: 91n }
    ],
    outgoing: [],
    fee: { faucetId: NATIVE, amount: 119n },
    inputNotesConsumed: 1,
    outputNotesCreated: 0,
    storageChanged: false
  };
  mockView.mockReturnValue(view);
});
it('captures the exact ordinary one-receipt request after authenticated import and simulation', async () => {
  expect(await prepareGcReceipt(context, issuance, new Uint8Array([9]))).toEqual({
    requestBytes: new Uint8Array([6]),
    requestFee: 119n
  });
  expect(mockBuild).toHaveBeenCalledWith([expect.anything()], 100, { preparedAuth: true });
  expect(mockSimulate).toHaveBeenCalledWith({
    address: ACCOUNT,
    transactionRequest: 'BA==',
    importNotes: ['CQ=='],
    capturePreparedRequest: true
  });
});
it('refuses a simulation consuming any other note even if the aggregate assets match', async () => {
  mockInputId.mockReturnValue(word);
  await expect(prepareGcReceipt(context, issuance, new Uint8Array([9]))).rejects.toThrow('different note');
});
it('fails closed in another owning realm or when authenticated receipt identity changes', async () => {
  mockRunsHere.mockReturnValue(false);
  await expect(prepareGcReceipt(context, issuance, new Uint8Array([9]))).rejects.toThrow('realm');
  mockRunsHere.mockReturnValue(true);
  await expect(prepareGcReceipt(context, { ...issuance, receiptNoteId: word }, new Uint8Array([9]))).rejects.toThrow(
    'identity'
  );
});
