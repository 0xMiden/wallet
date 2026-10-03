/* eslint-disable import/first -- the jest.mock() factory must be registered before the module under test is imported. */
/**
 * The exit-hash helper's own decisions, over a fake SDK (#1325). The real Poseidon2 is pinned by the golden vectors
 * in exit-hash.real-sdk.test.ts; here a fake hash spells out what it was given, so a test can see which words went
 * into it and in which order.
 */
const mockRequestDeserialize = jest.fn();

jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  // A fake word: its one felt is its name, and its hex spells that name.
  const fakeWord = (name: string) => ({ toFelts: () => [name], toHex: () => `0x${name}` });
  return {
    FeltArray: function FeltArray(items: string[]) {
      return { items };
    },
    Poseidon2: { hashElements: (array: { items: string[] }) => fakeWord(`h(${array.items.join(',')})`) },
    TransactionRequest: { deserialize: (...args: unknown[]) => mockRequestDeserialize(...args) }
  };
});

import { agglayerExitTxHashFromDetailsCommitment, agglayerExitTxHashFromRowBytes } from './exit-hash';
import fixture from './exit-hash.vectors.json';

const word = (name: string) => ({ toFelts: () => [name], toHex: () => `0x${name}` });
const assetsOf = (name: string) => ({
  fungibleAssets: () => [{ vaultKey: () => word(`${name}-key`), intoWord: () => word(`${name}-value`) }]
});
// What the fake hash makes of note `name`: the recipient digest first, then the assets commitment.
const exitHashOfFake = (name: string) =>
  agglayerExitTxHashFromDetailsCommitment(`0xh(${name}-recipient,h(${name}-key,${name}-value))`);

beforeEach(() => {
  mockRequestDeserialize.mockReset();
});

describe('agglayerExitTxHashFromDetailsCommitment', () => {
  it.each(fixture.vectors)('gives deposit $depositCnt the tx_hash the indexer filed it under', vector => {
    expect(agglayerExitTxHashFromDetailsCommitment(vector.detailsCommitment)).toBe(vector.exitTxHash);
  });

  it('reads the commitment whatever its case or 0x prefix', () => {
    const [vector] = fixture.vectors;
    if (vector === undefined) throw new Error('the fixture has no vectors');

    expect(agglayerExitTxHashFromDetailsCommitment(vector.detailsCommitment.toUpperCase())).toBe(vector.exitTxHash);
    expect(agglayerExitTxHashFromDetailsCommitment(vector.detailsCommitment.slice(2))).toBe(vector.exitTxHash);
  });
});

describe('agglayerExitTxHashFromRowBytes, from the request bytes', () => {
  const requestBytes = new Uint8Array([1]);
  const requestNote = (id: string, name: string) => ({
    id: () => ({ toString: () => id }),
    recipient: () => ({ digest: () => word(`${name}-recipient`) }),
    assets: () => assetsOf(name)
  });
  const requestWith = (...notes: ReturnType<typeof requestNote>[]) =>
    mockRequestDeserialize.mockReturnValue({ expectedOutputOwnNotes: () => notes });

  it('answers from the request bytes', () => {
    requestWith(requestNote('0xbridge', 'bridge'));

    expect(agglayerExitTxHashFromRowBytes({ requestBytes })).toBe(exitHashOfFake('bridge'));
    expect(agglayerExitTxHashFromRowBytes({ requestBytes, outputNoteIds: ['0xbridge'] })).toBe(
      exitHashOfFake('bridge')
    );
  });

  it('answers nothing when the request note is not the note the row recorded', () => {
    requestWith(requestNote('0xother', 'other'));

    expect(agglayerExitTxHashFromRowBytes({ requestBytes, outputNoteIds: ['0xbridge'] })).toBeUndefined();
  });

  it('answers nothing when the request carries more than one own note', () => {
    // Each request note is hashable, so taking the first of two would answer with its hash, not none.
    requestWith(requestNote('0xbridge', 'first'), requestNote('0xsecond', 'second'));

    expect(agglayerExitTxHashFromRowBytes({ requestBytes, outputNoteIds: ['0xbridge'] })).toBeUndefined();
  });

  it('answers nothing when the request bytes do not decode', () => {
    mockRequestDeserialize.mockImplementation(() => {
      throw new Error('failed to deserialize TransactionRequest');
    });

    expect(agglayerExitTxHashFromRowBytes({ requestBytes, outputNoteIds: ['0xbridge'] })).toBeUndefined();
  });
});

describe('agglayerExitTxHashFromRowBytes and a WebAssembly trap', () => {
  // The caller decodes under `withWasmClientLock`, and only a trap that reaches the lock retires the client.
  it('rethrows a trap from the request bytes', () => {
    mockRequestDeserialize.mockImplementation(() => {
      throw new WebAssembly.RuntimeError('unreachable');
    });

    expect(() =>
      agglayerExitTxHashFromRowBytes({ requestBytes: new Uint8Array([1]), outputNoteIds: ['0xbridge'] })
    ).toThrow(WebAssembly.RuntimeError);
  });
});
