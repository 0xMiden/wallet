const importNoteBytes = jest.fn(async () => 'noteid');
const syncState = jest.fn(async () => undefined);
const fakeClient = {};

jest.mock('lib/miden/sdk/miden-client', () => ({
  getMidenClient: jest.fn(async () => ({ client: fakeClient, importNoteBytes, syncState })),
  withWasmClientLock: jest.fn((fn: any) => fn())
}));
jest.mock('lib/miden/sdk/helpers', () => ({
  accountIdStringToSdk: jest.fn((s: string) => ({ __accountId: s }))
}));
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  TransactionRequest: { deserialize: jest.fn((bytes: Uint8Array) => ({ __req: bytes })) }
}));
jest.mock('@openzeppelin/miden-multisig-client', () => ({
  executeForSummary: jest.fn(async () => ({ serialize: () => new Uint8Array([1, 2, 3]) }))
}));
jest.mock('lib/shared/helpers', () => ({
  b64ToU8: jest.fn((s: string) => new Uint8Array([s.length])),
  u8ToB64: jest.fn((u: Uint8Array) => `b64:${Array.from(u).join('-')}`)
}));

import { executeForSummary } from '@openzeppelin/miden-multisig-client';
import { simulateCustomTransaction } from './simulate-custom-tx';

describe('simulateCustomTransaction', () => {
  beforeEach(() => jest.clearAllMocks());

  it('imports notes, syncs, executes for summary and returns serialized summary', async () => {
    const res = await simulateCustomTransaction({
      address: 'mtst1abc',
      transactionRequest: 'reqB64',
      importNotes: ['noteA', 'noteB']
    });
    expect(importNoteBytes).toHaveBeenCalledTimes(2);
    expect(syncState).toHaveBeenCalledTimes(1);
    expect(executeForSummary).toHaveBeenCalledWith(fakeClient, { __accountId: 'mtst1abc' }, { __req: expect.any(Uint8Array) });
    expect(res).toEqual({ summaryBytes: 'b64:1-2-3' });
  });

  it('tolerates a missing importNotes list', async () => {
    const res = await simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64' });
    expect(importNoteBytes).not.toHaveBeenCalled();
    expect(res.summaryBytes).toBe('b64:1-2-3');
  });

  it('returns { error } when execution throws, without rethrowing', async () => {
    (executeForSummary as jest.Mock).mockRejectedValueOnce(new Error('note not found'));
    const res = await simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64' });
    expect(res).toEqual({ error: 'note not found' });
  });

  it('returns a string error when execution rejects with a non-Error value', async () => {
    (executeForSummary as jest.Mock).mockRejectedValueOnce('boom');
    const res = await simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64' });
    expect(res).toEqual({ error: 'boom' });
  });
});
