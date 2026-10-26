/* eslint-disable import/first */
/**
 * A custom (`execute`) row records every note it will consume, the notes it carries included, so auto-consume and the
 * claim dedup leave them alone while the row runs. The carried notes are the ones a sync lap lists the moment the
 * confirm releases their quarantine, and an unrecorded one was claimed out from under the dApp's transaction.
 */

const mockQueueNoteImport = jest.fn((_noteBytes: string) => Promise.resolve(undefined));

jest.mock('../activity/notes', () => ({
  queueNoteImport: (noteBytes: string) => mockQueueNoteImport(noteBytes)
}));

jest.mock('../sdk/miden-client', () => ({
  withWasmClientLock: async <T>(fn: () => Promise<T>) => fn(),
  getMidenClient: async () => ({})
}));

// Carried bytes are bare notes here: the NoteFile parse fails, and the note's id is its decoded text.
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  ...jest.requireActual('@miden-sdk/miden-sdk/lazy'),
  NoteFile: {
    deserialize: () => {
      throw new Error('not a NoteFile');
    }
  },
  Note: {
    deserialize: (bytes: Uint8Array) => ({ id: () => ({ toString: () => Buffer.from(bytes).toString() }) })
  }
}));

import * as Repo from 'lib/miden/repo';

import { requestCustomTransaction, TransactionQueuedError } from './initiate';

const REQUEST_BYTES = Buffer.from('custom-request').toString('base64');
const carried = (id: string) => Buffer.from(id).toString('base64');

beforeEach(async () => {
  jest.clearAllMocks();
  mockQueueNoteImport.mockReset();
  mockQueueNoteImport.mockResolvedValue(undefined);
  await Repo.transactions.clear();
});

describe('requestCustomTransaction records the notes the row will consume', () => {
  it('records the carried notes alongside the ones the dApp names', async () => {
    await requestCustomTransaction('account-a', REQUEST_BYTES, ['named-note'], [carried('carried-note')]);

    expect(await Repo.transactions.toArray()).toEqual([
      expect.objectContaining({
        type: 'execute',
        heldNoteIds: ['named-note', 'carried-note'],
        inputNoteIds: ['named-note']
      })
    ]);
  });

  it('records a carried note the dApp also names once', async () => {
    await requestCustomTransaction('account-a', REQUEST_BYTES, ['same-note'], [carried('same-note')]);

    expect(await Repo.transactions.toArray()).toEqual([expect.objectContaining({ heldNoteIds: ['same-note'] })]);
  });

  it('records the carried notes when the dApp names none', async () => {
    await requestCustomTransaction('account-a', REQUEST_BYTES, undefined, [carried('a'), carried('b')]);

    expect(await Repo.transactions.toArray()).toEqual([expect.objectContaining({ heldNoteIds: ['a', 'b'] })]);
  });

  it('reports the queued id when a carried note cannot be queued after the insert', async () => {
    const queueError = new Error('note queue unavailable');
    mockQueueNoteImport.mockRejectedValueOnce(queueError);

    const request = requestCustomTransaction('account-a', REQUEST_BYTES, [], [carried('carried-note')]);

    await expect(request).rejects.toHaveProperty('name', 'TransactionQueuedError');
    await expect(request).rejects.toBeInstanceOf(TransactionQueuedError);
    const error: unknown = await request.catch((cause: unknown) => cause);
    if (!(error instanceof TransactionQueuedError)) throw error;

    const rows = await Repo.transactions.toArray();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    if (row === undefined) throw new Error('Expected one persisted transaction');
    expect(error.transactionId).toBe(row.id);
    expect(error.cause).toBe(queueError);
  });
});
