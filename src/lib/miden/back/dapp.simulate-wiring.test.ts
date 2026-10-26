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
  it('responds to a matching simulate request with the summary, no throw', async () => {
    const handler = makeSimulateHandler('confirm-id', customTx as any);
    const out = await handler({ type: MidenMessageType.DAppSimulateTransactionRequest, id: 'confirm-id' } as any);
    expect(simulateCustomTransaction).toHaveBeenCalledWith({
      address: 'mtst1sender',
      transactionRequest: 'reqB64',
      importNotes: ['noteB64']
    });
    expect(out).toEqual({
      type: MidenMessageType.DAppSimulateTransactionResponse,
      summaryBytes: 'sumB64',
      error: undefined
    });
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
    expect(out).toMatchObject({ summaryBytes: 'cachedB64' });
  });

  it("re-runs when the caller's dry run failed, instead of caching the failure", async () => {
    // A timeout or a WASM-lock eviction resolves as `{ error }`. Serving that for the lifetime of
    // the confirm id would leave the verified asset view - an anti-phishing control - permanently
    // unavailable even after the contention cleared.
    (simulateCustomTransaction as jest.Mock).mockClear();
    const handler = makeSimulateHandler('confirm-id', customTx as any, { error: 'Simulation timed out' });

    const out = await handler({ type: MidenMessageType.DAppSimulateTransactionRequest, id: 'confirm-id' } as any);

    expect(simulateCustomTransaction).toHaveBeenCalled();
    expect(out).toMatchObject({ summaryBytes: 'sumB64' });
  });

  // The reply hands a failed dry run's reason on to the sheet, so a deterministic kernel code reads as the copy the
  // Failed row gets there too (#1475).
  describe.each([
    ['missing fee conversion info', '14712559985122731094', TRANSACTION_FEE_CONVERSION_INFO_MISSING_ERROR],
    ["dApp's fee commitment mismatch", '15404814807981965102', TRANSACTION_FEE_COMMITMENT_MISMATCH_ERROR],
    ['vault shortfall', '644413868907058392', TRANSACTION_VAULT_SHORTFALL_ERROR]
  ])('a dry run failing with the %s code', (_name, code, copy) => {
    const kernelLine = `failed to execute transaction kernel program: assertion failed with error code: ${code}`;
    const simulateRequest: MidenDAppSimulateTransactionRequest = {
      type: MidenMessageType.DAppSimulateTransactionRequest,
      id: 'confirm-id'
    };

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
    const simulateRequest: MidenDAppSimulateTransactionRequest = {
      type: MidenMessageType.DAppSimulateTransactionRequest,
      id: 'confirm-id'
    };

    const out = await makeSimulateHandler('confirm-id', customTx)(simulateRequest);

    expect(out).toMatchObject({ error: 'Simulation timed out' });
  });

  it('ignores a simulate request for a different id', async () => {
    const handler = makeSimulateHandler('confirm-id', customTx as any);
    const out = await handler({ type: MidenMessageType.DAppSimulateTransactionRequest, id: 'other' } as any);
    expect(out).toBeUndefined();
  });
});
