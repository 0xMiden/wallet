import { simulatedBytesToView, type TxAssetView } from 'app/confirm/decode';
import { noteFlowFromSimulatedBytes } from 'app/confirm/note-flow';
import { SpendingLimitAssessmentDetails } from 'lib/miden/spending-limits/queue';
import { MidenDAppSimulateTransactionRequest, MidenMessageType } from 'lib/miden/types';

import { buildCustomTxConfirmPayload, makeSimulateHandler } from './dapp';
import { simulateCustomTransaction } from './simulate-custom-tx';

jest.mock('./simulate-custom-tx', () => ({
  simulateCustomTransaction: jest.fn(async () => ({ summaryBytes: 'sumB64' }))
}));
// A custom summary's approval reads the chain fee before it decodes and refuses when that read is unknown.
jest.mock('lib/miden-chain/native-asset', () => ({
  ...jest.requireActual('lib/miden-chain/native-asset'),
  refreshVerificationBaseFee: async () => 2,
  isVerificationBaseFeeKnownAbsent: () => false
}));
jest.mock('app/confirm/decode', () => ({
  ...jest.requireActual('app/confirm/decode'),
  simulatedBytesToView: jest.fn()
}));
jest.mock('app/confirm/note-flow', () => ({
  ...jest.requireActual('app/confirm/note-flow'),
  noteFlowFromSimulatedBytes: jest.fn()
}));

const decodedView = (): TxAssetView => ({
  outgoing: [{ faucetId: 'fA', amount: 500n }],
  incoming: [],
  outgoingNfts: [],
  incomingNfts: [],
  unlistedAssets: 0,
  inputNotesConsumed: 0,
  outputNotesCreated: 1,
  storageChanged: false
});
const wireView = {
  outgoing: [{ faucetId: 'fA', amount: '500' }],
  incoming: [],
  outgoingNfts: [],
  incomingNfts: [],
  unlistedAssets: 0,
  inputNotesConsumed: 0,
  outputNotesCreated: 1,
  storageChanged: false
};

const customTx = {
  address: 'mtst1sender',
  recipientAddress: 'mtst1recipient',
  transactionRequest: 'reqB64',
  inputNoteIds: ['n1'],
  importNotes: ['noteB64']
};

describe('buildCustomTxConfirmPayload', () => {
  it('carries the raw material + declared status, not just messages', () => {
    const p = buildCustomTxConfirmPayload({
      origin: 'https://dapp.test',
      networkRpc: 'rpc',
      appMeta: { name: 'DApp' },
      sourcePublicKey: 'pk',
      transactionMessages: ['a', 'b'],
      customTransaction: customTx as any
    });
    expect(p).toMatchObject({
      type: 'transaction',
      txKind: 'custom',
      requestBytes: 'reqB64',
      importNotes: ['noteB64'],
      recipientAddress: 'mtst1recipient'
    });
  });

  it('falls back to undefined when the dApp did not declare a recipient', () => {
    const p = buildCustomTxConfirmPayload({
      origin: 'https://dapp.test',
      networkRpc: 'rpc',
      appMeta: { name: 'DApp' },
      sourcePublicKey: 'pk',
      transactionMessages: ['a'],
      customTransaction: { ...customTx, recipientAddress: '' } as any
    });
    expect(p.recipientAddress).toBeUndefined();
  });

  const breachDetails = (): SpendingLimitAssessmentDetails => ({
    assessment: {
      accountId: 'miden-account-1',
      usdAmount: 60_000_000n,
      revision: 'revision-1',
      assessedAt: 1_000,
      breach: { spent: 0n, proposedTotal: 60_000_000n, limit: 50_000_000n, overBy: 10_000_000n, resetAt: null }
    }
  });

  it('carries a serialized spending-limit assessment when the details name a breach', () => {
    const p = buildCustomTxConfirmPayload({
      origin: 'https://dapp.test',
      networkRpc: 'rpc',
      appMeta: { name: 'DApp' },
      sourcePublicKey: 'pk',
      transactionMessages: ['a'],
      customTransaction: customTx,
      spendingLimitDetails: breachDetails()
    });

    expect(p).toMatchObject({
      spendingLimitAssessment: {
        accountId: 'miden-account-1',
        usdAmount: '60000000',
        revision: 'revision-1',
        breach: { spent: '0', proposedTotal: '60000000', limit: '50000000', overBy: '10000000', resetAt: null }
      }
    });
  });

  it('omits the assessment when the details carry no breach', () => {
    const p = buildCustomTxConfirmPayload({
      origin: 'https://dapp.test',
      networkRpc: 'rpc',
      appMeta: { name: 'DApp' },
      sourcePublicKey: 'pk',
      transactionMessages: ['a'],
      customTransaction: customTx,
      spendingLimitDetails: {
        assessment: {
          accountId: 'miden-account-1',
          usdAmount: 10_000_000n,
          revision: 'revision-1',
          assessedAt: 1_000
        }
      }
    });

    expect(p).not.toHaveProperty('spendingLimitAssessment');
  });
});

describe('makeSimulateHandler', () => {
  const simulateRequest: MidenDAppSimulateTransactionRequest = {
    type: MidenMessageType.DAppSimulateTransactionRequest,
    id: 'confirm-id'
  };

  /** What the approval measured from the holdings: a held 1000 spent, so 1050 leaves where the vault nets 50. */
  const approvedView = (): TxAssetView => ({
    ...decodedView(),
    outgoing: [{ faucetId: 'fA', amount: 1050n }],
    inputNotesConsumed: 1,
    viewConsumedNotes: [{ id: '0xheld', amounts: [{ faucetId: 'fA', amount: 1000n }], nfts: [] }],
    createdNotes: [{ id: '0xsent', amounts: [{ faucetId: 'fA', amount: 1050n }], nfts: [] }],
    heldNotesSpent: 1
  });
  const approvedWireView = {
    ...wireView,
    outgoing: [{ faucetId: 'fA', amount: '1050' }],
    inputNotesConsumed: 1,
    heldNotesSpent: 1
  };

  beforeEach(() => {
    jest.mocked(simulateCustomTransaction).mockClear();
    jest
      .mocked(simulatedBytesToView)
      .mockReset()
      .mockImplementation(result => (result.summaryBytes || result.executedBytes ? decodedView() : undefined));
    jest.mocked(noteFlowFromSimulatedBytes).mockReset().mockReturnValue(undefined);
  });

  it('answers with the approval view it is given, never simulating or decoding the view again', async () => {
    const out = await makeSimulateHandler('confirm-id', approvedView(), { summaryBytes: 'sumB64' })(simulateRequest);

    expect(out).toEqual({
      type: MidenMessageType.DAppSimulateTransactionResponse,
      effects: { view: approvedWireView }
    });
    expect(simulateCustomTransaction).not.toHaveBeenCalled();
    expect(simulatedBytesToView).not.toHaveBeenCalled();
  });

  it("carries the dry run's note flow beside the view and never the dry-run bytes", async () => {
    jest.mocked(noteFlowFromSimulatedBytes).mockReturnValueOnce({
      inputCount: 0,
      inputs: [],
      outputs: [{ kind: 'P2ID', visibility: 'public', assets: [{ faucetId: 'fA', amount: 500n }] }]
    });

    const out = await makeSimulateHandler('confirm-id', decodedView(), { executedBytes: 'execB64' })(simulateRequest);

    expect(noteFlowFromSimulatedBytes).toHaveBeenCalledWith({ executedBytes: 'execB64' });
    expect(out?.effects?.view).toEqual(wireView);
    expect(out?.effects?.noteFlow?.outputs[0]?.assets).toEqual([{ faucetId: 'fA', amount: '500' }]);
    expect(out).not.toHaveProperty('executedBytes');
    expect(JSON.stringify(out)).not.toContain('execB64');
  });

  it('keeps the view when only the note flow cannot be decoded', async () => {
    jest.mocked(noteFlowFromSimulatedBytes).mockImplementationOnce(() => {
      throw new Error('bad note bytes');
    });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const out = await makeSimulateHandler('confirm-id', decodedView(), { summaryBytes: 'sumB64' })(simulateRequest);

      expect(out).toEqual({ type: MidenMessageType.DAppSimulateTransactionResponse, effects: { view: wireView } });
      expect(out?.effects).not.toHaveProperty('noteFlow');
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('answers an error and no effects when it has no approval view', async () => {
    const out = await makeSimulateHandler('confirm-id', undefined, { summaryBytes: 'sumB64' })(simulateRequest);

    expect(out).toEqual({
      type: MidenMessageType.DAppSimulateTransactionResponse,
      error: 'the request has no approved effects to show'
    });
    expect(simulateCustomTransaction).not.toHaveBeenCalled();
    expect(simulatedBytesToView).not.toHaveBeenCalled();
    expect(noteFlowFromSimulatedBytes).not.toHaveBeenCalled();
  });

  it('ignores a simulate request for a different id', async () => {
    const out = await makeSimulateHandler(
      'confirm-id',
      approvedView()
    )({ type: MidenMessageType.DAppSimulateTransactionRequest, id: 'other' });

    expect(out).toBeUndefined();
  });
});
