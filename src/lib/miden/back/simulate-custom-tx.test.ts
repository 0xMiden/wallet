import { executeForSummary } from '@openzeppelin/miden-multisig-client';

import { importedNoteIds, quarantineNoteIds } from 'lib/miden/note-quarantine';
import { accountIdStringToSdk } from 'lib/miden/sdk/helpers';

import { simulateCustomTransaction } from './simulate-custom-tx';

const importNoteBytes = jest.fn(async () => 'noteid');
const syncState = jest.fn(async () => undefined);
const fakeClient = {};

jest.mock('lib/miden/sdk/miden-client', () => ({
  getMidenClient: jest.fn(async () => ({ client: fakeClient, importNoteBytes, syncState })),
  withWasmClientLock: jest.fn((fn: any) => fn())
}));
jest.mock('lib/miden/sdk/helpers', () => ({
  accountIdStringToSdk: jest.fn((s: string) => ({ toString: () => `hex:${s}` }))
}));
jest.mock('lib/miden/note-quarantine', () => ({
  importedNoteIds: jest.fn((notes: string[] | undefined) => (notes ?? []).map(n => `id:${n}`)),
  quarantineNoteIds: jest.fn(async () => undefined)
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
    expect(executeForSummary).toHaveBeenCalledWith(
      fakeClient,
      'hex:mtst1abc',
      { __req: expect.any(Uint8Array) },
      expect.any(String)
    );
    expect(res).toEqual({ summaryBytes: 'b64:1-2-3' });
  });

  it('quarantines the imported notes (derived ids) before importing them', async () => {
    await simulateCustomTransaction({
      address: 'mtst1abc',
      transactionRequest: 'reqB64',
      importNotes: ['noteA', 'noteB']
    });
    expect(importedNoteIds).toHaveBeenCalledWith(['noteA', 'noteB']);
    expect(quarantineNoteIds).toHaveBeenCalledWith(['id:noteA', 'id:noteB']);
    // Quarantine must be placed before the notes actually land in the client DB.
    const quarantineOrder = (quarantineNoteIds as jest.Mock).mock.invocationCallOrder[0]!;
    const importOrder = importNoteBytes.mock.invocationCallOrder[0]!;
    expect(quarantineOrder).toBeLessThan(importOrder);
  });

  it('quarantines with an empty id list when importNotes is missing', async () => {
    await simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64' });
    expect(importedNoteIds).toHaveBeenCalledWith(undefined);
    expect(quarantineNoteIds).toHaveBeenCalledWith([]);
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

  it('passes a hex address straight through without calling accountIdStringToSdk', async () => {
    const res = await simulateCustomTransaction({ address: '0xabc', transactionRequest: 'reqB64' });
    expect(executeForSummary).toHaveBeenCalledWith(
      fakeClient,
      '0xabc',
      { __req: expect.any(Uint8Array) },
      expect.any(String)
    );
    expect(accountIdStringToSdk as jest.Mock).not.toHaveBeenCalled();
    expect(res).toEqual({ summaryBytes: 'b64:1-2-3' });
  });

  it('times out and returns { error: "Simulation timed out" } when the locked work hangs', async () => {
    jest.useFakeTimers();
    try {
      (executeForSummary as jest.Mock).mockImplementationOnce(() => new Promise(() => {}));

      const resultPromise = simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64' });

      jest.advanceTimersByTime(20_000);
      await Promise.resolve();
      await Promise.resolve();

      const res = await resultPromise;
      expect(res).toEqual({ error: 'Simulation timed out' });
    } finally {
      jest.useRealTimers();
    }
  });
});
