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

  it('ignores a simulate request for a different id', async () => {
    const handler = makeSimulateHandler('confirm-id', customTx as any);
    const out = await handler({ type: MidenMessageType.DAppSimulateTransactionRequest, id: 'other' } as any);
    expect(out).toBeUndefined();
  });
});
