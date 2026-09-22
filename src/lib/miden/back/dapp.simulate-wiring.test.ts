import { SpendingLimitAssessmentDetails } from 'lib/miden/spending-limits/queue';
import { MidenMessageType } from 'lib/miden/types';

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

  it('ignores a simulate request for a different id', async () => {
    const handler = makeSimulateHandler('confirm-id', customTx as any);
    const out = await handler({ type: MidenMessageType.DAppSimulateTransactionRequest, id: 'other' } as any);
    expect(out).toBeUndefined();
  });
});
