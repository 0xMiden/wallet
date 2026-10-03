/* eslint-disable import/first -- the jest.mock() factory must be registered before the module under test is imported. */
/**
 * The exit-hash helper's own decisions, over a fake SDK (#1325). The real Poseidon2 is pinned by the golden vectors
 * in exit-hash.real-sdk.test.ts; here a fake hash spells out what it was given, so a test can see which words went
 * into it and in which order.
 */
const mockRequestDeserialize = jest.fn();
const mockResultDeserialize = jest.fn();

jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  // A fake word: its one felt is its name, and its hex spells that name.
  const fakeWord = (name: string) => ({ toFelts: () => [name], toHex: () => `0x${name}` });
  return {
    FeltArray: function FeltArray(items: string[]) {
      return { items };
    },
    Poseidon2: { hashElements: (array: { items: string[] }) => fakeWord(`h(${array.items.join(',')})`) },
    TransactionRequest: { deserialize: (...args: unknown[]) => mockRequestDeserialize(...args) },
    TransactionResult: { deserialize: (...args: unknown[]) => mockResultDeserialize(...args) }
  };
});

import { agglayerExitTxHashFromDetailsCommitment, agglayerExitTxHashFromRowBytes } from './exit-hash';
import fixture from './exit-hash.vectors.json';

const word = (name: string) => ({ toFelts: () => [name], toHex: () => `0x${name}` });
const assetsOf = (name: string) => ({
  fungibleAssets: () => [{ vaultKey: () => word(`${name}-key`), intoWord: () => word(`${name}-value`) }]
});
const outputNote = (id: string, name: string, withAssets = true) => ({
  id: () => ({ toString: () => id }),
  recipientDigest: () => word(`${name}-recipient`),
  assets: () => (withAssets ? assetsOf(name) : undefined)
});
const resultWith = (...notes: ReturnType<typeof outputNote>[]) => ({
  executedTransaction: () => ({ userOutputNotes: () => notes })
});
// What the fake hash makes of note `name`: the recipient digest first, then the assets commitment.
const exitHashOfFake = (name: string) =>
  agglayerExitTxHashFromDetailsCommitment(`0xh(${name}-recipient,h(${name}-key,${name}-value))`);

beforeEach(() => {
  mockRequestDeserialize.mockReset();
  mockResultDeserialize.mockReset();
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

describe('agglayerExitTxHashFromRowBytes, from the result bytes', () => {
  const resultBytes = new Uint8Array([9]);

  it('hashes the output note the row recorded, not the first one (a fee note can come first)', () => {
    mockResultDeserialize.mockReturnValue(resultWith(outputNote('0xfee', 'fee'), outputNote('0xbridge', 'bridge')));

    expect(agglayerExitTxHashFromRowBytes({ resultBytes, outputNoteIds: ['0xbridge'] })).toBe(exitHashOfFake('bridge'));
  });

  it('answers nothing when no output note is the recorded one, or it carries no assets', () => {
    mockResultDeserialize.mockReturnValue(
      resultWith(outputNote('0xother', 'other'), outputNote('0xbridge', 'bridge', false))
    );

    expect(agglayerExitTxHashFromRowBytes({ resultBytes, outputNoteIds: ['0xmissing'] })).toBeUndefined();
    expect(agglayerExitTxHashFromRowBytes({ resultBytes, outputNoteIds: ['0xbridge'] })).toBeUndefined();
  });

  it('never reads result bytes without a recorded note id to match', () => {
    expect(agglayerExitTxHashFromRowBytes({ resultBytes })).toBeUndefined();
    expect(mockResultDeserialize).not.toHaveBeenCalled();
  });

  it('falls through to the result bytes when the request bytes do not decode', () => {
    mockRequestDeserialize.mockImplementation(() => {
      throw new Error('failed to deserialize TransactionRequest');
    });
    mockResultDeserialize.mockReturnValue(resultWith(outputNote('0xbridge', 'bridge')));

    expect(
      agglayerExitTxHashFromRowBytes({ requestBytes: new Uint8Array([1]), resultBytes, outputNoteIds: ['0xbridge'] })
    ).toBe(exitHashOfFake('bridge'));
  });

  it('falls through when the request carries more than one own note', () => {
    // Each request note is hashable, so taking the first of two would answer with its hash, not none.
    const requestNote = (id: string, name: string) => ({
      id: () => ({ toString: () => id }),
      recipient: () => ({ digest: () => word(`${name}-recipient`) }),
      assets: () => assetsOf(name)
    });
    mockRequestDeserialize.mockReturnValue({
      expectedOutputOwnNotes: () => [requestNote('0xbridge', 'first'), requestNote('0xsecond', 'second')]
    });
    mockResultDeserialize.mockReturnValue(resultWith(outputNote('0xbridge', 'bridge')));

    expect(
      agglayerExitTxHashFromRowBytes({ requestBytes: new Uint8Array([1]), resultBytes, outputNoteIds: ['0xbridge'] })
    ).toBe(exitHashOfFake('bridge'));
  });
});

describe('agglayerExitTxHashFromRowBytes and a WebAssembly trap', () => {
  // The caller decodes under `withWasmClientLock`, and only a trap that reaches the lock retires the client.
  it('rethrows a trap from the request bytes without reading the result bytes', () => {
    mockRequestDeserialize.mockImplementation(() => {
      throw new WebAssembly.RuntimeError('unreachable');
    });

    expect(() =>
      agglayerExitTxHashFromRowBytes({
        requestBytes: new Uint8Array([1]),
        resultBytes: new Uint8Array([9]),
        outputNoteIds: ['0xbridge']
      })
    ).toThrow(WebAssembly.RuntimeError);
    expect(mockResultDeserialize).not.toHaveBeenCalled();
  });

  it('rethrows a trap from the result bytes', () => {
    mockResultDeserialize.mockImplementation(() => {
      throw new WebAssembly.RuntimeError('unreachable');
    });

    expect(() =>
      agglayerExitTxHashFromRowBytes({ resultBytes: new Uint8Array([9]), outputNoteIds: ['0xbridge'] })
    ).toThrow(WebAssembly.RuntimeError);
  });
});
