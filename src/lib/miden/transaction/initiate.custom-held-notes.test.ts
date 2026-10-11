/* eslint-disable import/first */
/**
 * A custom (`execute`) row records every note it will consume, the notes it carries included, so auto-consume and the
 * claim dedup leave them alone while the row runs. The carried notes are the ones a sync lap lists the moment the
 * confirm releases their quarantine, and an unrecorded one was claimed out from under the dApp's transaction.
 */

const mockAdd = jest.fn((..._args: unknown[]) => Promise.resolve(undefined));

jest.mock('../repo', () => ({
  transactions: {
    add: (...args: unknown[]) => mockAdd(...args)
  }
}));

jest.mock('../activity/notes', () => ({
  queueNoteImport: () => Promise.resolve(undefined)
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

import { requestCustomTransaction } from './initiate';

const REQUEST_BYTES = Buffer.from('custom-request').toString('base64');
const carried = (id: string) => Buffer.from(id).toString('base64');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('requestCustomTransaction records the notes the row will consume', () => {
  it('records the carried notes alongside the ones the dApp names', async () => {
    await requestCustomTransaction('account-a', REQUEST_BYTES, ['named-note'], [carried('carried-note')]);

    expect(mockAdd).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'execute', heldNoteIds: ['named-note', 'carried-note'] })
    );
    // The dApp's own list is left as it sent it.
    expect(mockAdd).toHaveBeenCalledWith(expect.objectContaining({ inputNoteIds: ['named-note'] }));
  });

  it('records a carried note the dApp also names once', async () => {
    await requestCustomTransaction('account-a', REQUEST_BYTES, ['same-note'], [carried('same-note')]);

    expect(mockAdd).toHaveBeenCalledWith(expect.objectContaining({ heldNoteIds: ['same-note'] }));
  });

  it('records the carried notes when the dApp names none', async () => {
    await requestCustomTransaction('account-a', REQUEST_BYTES, undefined, [carried('a'), carried('b')]);

    expect(mockAdd).toHaveBeenCalledWith(expect.objectContaining({ heldNoteIds: ['a', 'b'] }));
  });
});
