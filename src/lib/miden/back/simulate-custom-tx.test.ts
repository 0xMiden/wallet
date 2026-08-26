import { executeForSummary } from '@openzeppelin/miden-multisig-client';

import { importedNoteIds, quarantineNoteIds } from 'lib/miden/note-quarantine';
import { accountIdStringToSdk } from 'lib/miden/sdk/helpers';

import { simulateCustomTransaction } from './simulate-custom-tx';

const importNoteBytes = jest.fn(async () => 'noteid');
const syncState = jest.fn(async () => undefined);
// Provenance lookup: `null` = the wallet does NOT already hold this note, so the
// dry run is the thing introducing it. Defaults to "not held" for every id.
const getInputNote = jest.fn(async (_id: string): Promise<unknown> => null);
const executeRequest = jest.fn(async () => ({ result: { serialize: () => new Uint8Array([9, 9]) } }));
const fakeClient = { transactions: { executeRequest } };

jest.mock('lib/miden/sdk/miden-client', () => ({
  getMidenClient: jest.fn(async () => ({ client: fakeClient, importNoteBytes, syncState, getInputNote })),
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
  executeForSummary: jest.fn(async () => ({
    summary: { serialize: () => new Uint8Array([1, 2, 3]) },
    anchor: { __anchor: true }
  }))
}));
jest.mock('lib/shared/helpers', () => ({
  b64ToU8: jest.fn((s: string) => new Uint8Array([s.length])),
  u8ToB64: jest.fn((u: Uint8Array) => `b64:${Array.from(u).join('-')}`)
}));

describe('simulateCustomTransaction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getInputNote.mockImplementation(async () => null);
  });

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
    expect(getInputNote).not.toHaveBeenCalled();
  });

  it('does NOT quarantine a note the wallet already holds', async () => {
    // The dApp controls `importNotes` and a decline releases nothing, so
    // quarantining an already-held note would hide the user's own claimable
    // funds permanently. Only the ids this dry run introduces may be hidden.
    getInputNote.mockImplementation(async (id: string) => (id === 'id:noteA' ? { alreadyHere: true } : null));
    await simulateCustomTransaction({
      address: 'mtst1abc',
      transactionRequest: 'reqB64',
      importNotes: ['noteA', 'noteB']
    });
    expect(getInputNote).toHaveBeenCalledWith('id:noteA');
    expect(quarantineNoteIds).toHaveBeenCalledWith(['id:noteB']);
  });

  it('treats a failed provenance lookup as already-held (quarantines nothing)', async () => {
    getInputNote.mockRejectedValueOnce(new Error('note store unavailable'));
    await simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64', importNotes: ['noteA'] });
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

  // Regression: web-sdk 0.16 inverted `executeForSummary`'s contract — the summary
  // only exists while authorization is PENDING, and a transaction that executes
  // successfully now rejects with `TRANSACTION_ALREADY_AUTHORIZED`. That is every
  // ordinary single-sig account, so the confirm screen's verified (ground-truth)
  // asset view — the anti-phishing control — was unreachable for all of them and
  // the UI showed the loss as a transient "could not verify by simulation".
  it.each([
    ['an error carrying the SDK code', Object.assign(new Error('nope'), { code: 'TRANSACTION_ALREADY_AUTHORIZED' })],
    ['a Node-style code-prefixed message', new Error('TRANSACTION_ALREADY_AUTHORIZED: no summary produced')],
    ['the SDK display text', new Error('transaction is already fully authorized, so no transaction summary')]
  ])('falls back to a local execution when the account is already authorized (%s)', async (_label, err) => {
    (executeForSummary as jest.Mock).mockRejectedValueOnce(err);

    const res = await simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64' });

    // Executed locally against the same account — nothing proven or submitted.
    expect(executeRequest).toHaveBeenCalledWith('hex:mtst1abc', { __req: expect.any(Uint8Array) });
    expect(res).toEqual({ executedBytes: 'b64:9-9' });
  });

  it('still reports a genuine execution failure as { error } rather than executing locally', async () => {
    (executeForSummary as jest.Mock).mockRejectedValueOnce(new Error('note not found'));

    const res = await simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64' });

    expect(executeRequest).not.toHaveBeenCalled();
    expect(res).toEqual({ error: 'note not found' });
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
