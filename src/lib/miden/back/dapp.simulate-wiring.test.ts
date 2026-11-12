import { simulatedBytesToView, type TxAssetView } from 'app/confirm/decode';
import { noteFlowFromSimulatedBytes } from 'app/confirm/note-flow';
import { SpendingLimitAssessmentDetails } from 'lib/miden/spending-limits/queue';
import {
  TRANSACTION_FEE_COMMITMENT_MISMATCH_ERROR,
  TRANSACTION_FEE_CONVERSION_INFO_MISSING_ERROR,
  TRANSACTION_VAULT_SHORTFALL_ERROR
} from 'lib/miden/transaction/constants';
import { MidenDAppSimulateTransactionRequest, MidenMessageType } from 'lib/miden/types';

import { buildCustomTxConfirmPayload, makeSimulateHandler } from './dapp';
import { simulateCustomTransaction } from './simulate-custom-tx';

jest.mock('./simulate-custom-tx', () => ({
  simulateCustomTransaction: jest.fn(async () => ({ summaryBytes: 'sumB64' }))
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

  beforeEach(() => {
    jest
      .mocked(simulatedBytesToView)
      .mockReset()
      .mockImplementation(result => (result.summaryBytes || result.executedBytes ? decodedView() : undefined));
    jest.mocked(noteFlowFromSimulatedBytes).mockReset().mockReturnValue(undefined);
  });

  it('responds to a matching simulate request with the summary, no throw', async () => {
    const handler = makeSimulateHandler('confirm-id', customTx as any);
    const out = await handler({ type: MidenMessageType.DAppSimulateTransactionRequest, id: 'confirm-id' } as any);
    expect(simulateCustomTransaction).toHaveBeenCalledWith({
      address: 'mtst1sender',
      transactionRequest: 'reqB64',
      importNotes: ['noteB64']
    });
    expect(simulatedBytesToView).toHaveBeenCalledWith({ summaryBytes: 'sumB64' });
    expect(out).toEqual({
      type: MidenMessageType.DAppSimulateTransactionResponse,
      effects: { view: wireView }
    });
  });

  it('answers an executed dry run with its decoded effects and never the executed transaction', async () => {
    jest
      .mocked(simulateCustomTransaction)
      .mockResolvedValueOnce({ executedBytes: 'execB64', introducedCredit: [], introducedCount: 0 });
    jest.mocked(noteFlowFromSimulatedBytes).mockReturnValueOnce({
      inputCount: 0,
      inputs: [],
      outputs: [{ kind: 'P2ID', visibility: 'public', assets: [{ faucetId: 'fA', amount: 500n }] }]
    });

    const out = await makeSimulateHandler('confirm-id', customTx)(simulateRequest);

    expect(simulatedBytesToView).toHaveBeenCalledWith(expect.objectContaining({ executedBytes: 'execB64' }));
    expect(out?.effects?.view.outgoing).toEqual([{ faucetId: 'fA', amount: '500' }]);
    expect(out?.effects?.noteFlow?.outputs[0]?.assets).toEqual([{ faucetId: 'fA', amount: '500' }]);
    expect(out).not.toHaveProperty('executedBytes');
    expect(out).not.toHaveProperty('summaryBytes');
    expect(JSON.stringify(out)).not.toContain('execB64');
  });

  it('answers a summary dry run the same way', async () => {
    jest.mocked(simulateCustomTransaction).mockResolvedValueOnce({ summaryBytes: 'sumB64', introducedCount: 0 });

    const out = await makeSimulateHandler('confirm-id', customTx)(simulateRequest);

    expect(out?.effects?.view.outgoing).toEqual([{ faucetId: 'fA', amount: '500' }]);
    expect(out).not.toHaveProperty('executedBytes');
    expect(out).not.toHaveProperty('summaryBytes');
    expect(out).not.toHaveProperty('error');
    expect(JSON.stringify(out)).not.toContain('sumB64');
  });

  it('keeps the view when only the note flow cannot be decoded', async () => {
    jest.mocked(noteFlowFromSimulatedBytes).mockImplementationOnce(() => {
      throw new Error('bad note bytes');
    });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const out = await makeSimulateHandler('confirm-id', customTx)(simulateRequest);

      expect(out).toEqual({ type: MidenMessageType.DAppSimulateTransactionResponse, effects: { view: wireView } });
      expect(out?.effects).not.toHaveProperty('noteFlow');
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('answers an error and no effects when the dry run cannot be decoded', async () => {
    jest.mocked(simulatedBytesToView).mockImplementationOnce(() => {
      throw new Error('bad summary bytes');
    });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const thrown = await makeSimulateHandler('confirm-id', customTx)(simulateRequest);
      jest.mocked(simulatedBytesToView).mockReturnValueOnce(undefined);
      const unread = await makeSimulateHandler('confirm-id', customTx)(simulateRequest);

      for (const out of [thrown, unread]) {
        expect(out).toEqual({
          type: MidenMessageType.DAppSimulateTransactionResponse,
          error: 'the simulated transaction could not be read'
        });
        expect(JSON.stringify(out)).not.toContain('sumB64');
      }
      expect(noteFlowFromSimulatedBytes).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  // A MATCHED PAIR, and they must stay one: each pins the case the other's fix would otherwise
  // make vacuous. The first says a usable dry run is reused so the request is simulated once; the
  // second says a FAILED one is not, so the sheet can still get a verified view once the lock
  // frees. Asserting only the first would pass with the reuse deleted; only the second, with the
  // reuse made unconditional.
  it('reuses a dry run the caller already performed, rather than simulating twice', async () => {
    (simulateCustomTransaction as jest.Mock).mockClear();
    const handler = makeSimulateHandler('confirm-id', customTx as any, { summaryBytes: 'cachedB64' });

    const out = await handler({ type: MidenMessageType.DAppSimulateTransactionRequest, id: 'confirm-id' } as any);

    expect(simulateCustomTransaction).not.toHaveBeenCalled();
    expect(simulatedBytesToView).toHaveBeenCalledWith({ summaryBytes: 'cachedB64' });
    expect(out).toEqual({ type: MidenMessageType.DAppSimulateTransactionResponse, effects: { view: wireView } });
  });

  it("re-runs when the caller's dry run failed, instead of caching the failure", async () => {
    // A timeout or a WASM-lock eviction resolves as `{ error }`. Serving that for the lifetime of
    // the confirm id would leave the verified asset view - an anti-phishing control - permanently
    // unavailable even after the contention cleared.
    (simulateCustomTransaction as jest.Mock).mockClear();
    const handler = makeSimulateHandler('confirm-id', customTx as any, { error: 'Simulation timed out' });

    const out = await handler({ type: MidenMessageType.DAppSimulateTransactionRequest, id: 'confirm-id' } as any);

    expect(simulateCustomTransaction).toHaveBeenCalled();
    expect(simulatedBytesToView).toHaveBeenCalledTimes(1);
    expect(simulatedBytesToView).toHaveBeenCalledWith({ summaryBytes: 'sumB64' });
    expect(out).toEqual({ type: MidenMessageType.DAppSimulateTransactionResponse, effects: { view: wireView } });
  });

  // The reply hands a failed dry run's reason on to the sheet, so a deterministic kernel code reads as the copy the
  // Failed row gets there too (#1475).
  describe.each([
    ['missing fee conversion info', '14712559985122731094', TRANSACTION_FEE_CONVERSION_INFO_MISSING_ERROR],
    ["dApp's fee commitment mismatch", '15404814807981965102', TRANSACTION_FEE_COMMITMENT_MISMATCH_ERROR],
    ['vault shortfall', '644413868907058392', TRANSACTION_VAULT_SHORTFALL_ERROR]
  ])('a dry run failing with the %s code', (_name, code, copy) => {
    const kernelLine = `failed to execute transaction kernel program: assertion failed with error code: ${code}`;

    it('replies with the Failed row copy, never the code', async () => {
      jest.mocked(simulateCustomTransaction).mockResolvedValueOnce({ error: kernelLine });

      const out = await makeSimulateHandler('confirm-id', customTx)(simulateRequest);

      expect(out).toMatchObject({ error: copy });
      expect(JSON.stringify(out)).not.toContain(code);
    });

    it('replies with the same copy when it reruns a failed cached dry run', async () => {
      jest.mocked(simulateCustomTransaction).mockClear();
      jest.mocked(simulateCustomTransaction).mockResolvedValueOnce({ error: kernelLine });

      const out = await makeSimulateHandler('confirm-id', customTx, { error: kernelLine })(simulateRequest);

      expect(simulateCustomTransaction).toHaveBeenCalledTimes(1);
      expect(out).toMatchObject({ error: copy });
      expect(JSON.stringify(out)).not.toContain(code);
    });
  });

  it('replies with the text of a failure that carries no named code', async () => {
    jest.mocked(simulateCustomTransaction).mockResolvedValueOnce({ error: 'Simulation timed out' });

    const out = await makeSimulateHandler('confirm-id', customTx)(simulateRequest);

    expect(out).toMatchObject({ error: 'Simulation timed out' });
  });

  it('ignores a simulate request for a different id', async () => {
    const handler = makeSimulateHandler('confirm-id', customTx as any);
    const out = await handler({ type: MidenMessageType.DAppSimulateTransactionRequest, id: 'other' } as any);
    expect(out).toBeUndefined();
  });
});
