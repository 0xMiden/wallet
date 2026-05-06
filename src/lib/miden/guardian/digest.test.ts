/**
 * AuthDigest is a thin wrapper over the WASM-provided Felt / FeltArray /
 * Rpo256 / AccountId / Word primitives. The tests stub all of those so
 * we can assert the wrapper's behavior without running the real WASM.
 *
 * What we assert:
 *   - fromAccountIdWithTimestamp parses "0x"-prefixed and bare hex, and
 *     builds the Felt array [prefix, suffix, timestamp, 0].
 *   - fromRequest delegates to the private payload-word builder and
 *     forwards the resulting Felt array to Rpo256.hashElements.
 *   - fromCommitmentHex pads to 32 bytes of hex regardless of input.
 *   - empty-bytes and non-empty-bytes payload paths both produce Words.
 */

import { AuthDigest } from './digest';

const accountIdFromHex = jest.fn();
const rpoHashElements = jest.fn();
const wordFromHex = jest.fn();
const feltCtor = jest.fn();
const feltArrayCtor = jest.fn();

jest.mock('@miden-sdk/miden-sdk', () => {
  class FeltStub {
    value: bigint;
    constructor(v: bigint) {
      this.value = v;
      feltCtor(v);
    }
  }
  class FeltArrayStub {
    elements: unknown[];
    constructor(els: unknown[]) {
      this.elements = els;
      feltArrayCtor(els);
    }
  }
  return {
    AccountId: { fromHex: (...a: unknown[]) => accountIdFromHex(...a) },
    Felt: FeltStub,
    FeltArray: FeltArrayStub,
    Rpo256: { hashElements: (...a: unknown[]) => rpoHashElements(...a) },
    Word: { fromHex: (...a: unknown[]) => wordFromHex(...a) }
  };
});
// The stubs above identify Felt instances by their `.value` bigint.
type FeltLike = { value: bigint };

describe('AuthDigest', () => {
  const makeParsedAccount = (prefix: unknown, suffix: unknown) => ({
    prefix: () => prefix,
    suffix: () => suffix
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('fromAccountIdWithTimestamp', () => {
    it('parses a 0x-prefixed account id and hashes [prefix, suffix, ts, 0]', () => {
      accountIdFromHex.mockReturnValueOnce(makeParsedAccount('PREFIX', 'SUFFIX'));
      rpoHashElements.mockReturnValueOnce('digest-word');

      const out = AuthDigest.fromAccountIdWithTimestamp('0xabcdef', 42);

      expect(accountIdFromHex).toHaveBeenCalledWith('0xabcdef');
      const feltArrayArg = feltArrayCtor.mock.calls[0]?.[0] as FeltLike[];
      expect(feltArrayArg).toHaveLength(4);
      expect(feltArrayArg[0]).toBe('PREFIX');
      expect(feltArrayArg[1]).toBe('SUFFIX');
      expect(feltArrayArg[2]?.value).toBe(42n);
      expect(feltArrayArg[3]?.value).toBe(0n);
      expect(rpoHashElements).toHaveBeenCalled();
      expect(out).toBe('digest-word');
    });

    it('adds the 0x prefix when the input is missing it', () => {
      accountIdFromHex.mockReturnValueOnce(makeParsedAccount(0n, 0n));
      rpoHashElements.mockReturnValueOnce('w');

      AuthDigest.fromAccountIdWithTimestamp('abcdef', 1);

      expect(accountIdFromHex).toHaveBeenCalledWith('0xabcdef');
    });
  });

  describe('fromRequest', () => {
    it('hashes the payload bytes into a Word, then folds it into the digest', () => {
      // Two calls to hashElements: one for the payload, one for the final
      // [prefix, suffix, ts, ...payloadWord] array.
      accountIdFromHex.mockReturnValueOnce(makeParsedAccount('P', 'S'));
      const payloadWord = { toFelts: () => ['f1', 'f2', 'f3', 'f4'] };
      rpoHashElements.mockReturnValueOnce(payloadWord).mockReturnValueOnce('final-digest');

      const requestPayload = { toBytes: () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]) } as never;
      const out = AuthDigest.fromRequest('0xface', 100, requestPayload);

      expect(out).toBe('final-digest');
      // Final FeltArray contains 7 entries: [P, S, tsFelt, ...4 payload felts]
      const finalFeltArrayArg = feltArrayCtor.mock.calls[1]?.[0] as unknown[];
      expect(finalFeltArrayArg?.length).toBe(7);
      expect(finalFeltArrayArg?.[0]).toBe('P');
      expect(finalFeltArrayArg?.[1]).toBe('S');
      expect(finalFeltArrayArg?.[3]).toBe('f1');
    });

    it('adds the 0x prefix to the account id when the caller passes bare hex', () => {
      // Exercises the false branch of the 0x-prefix ternary inside the
      // private `fromAccountIdTimestampAndPayloadWord` path.
      accountIdFromHex.mockReturnValueOnce(makeParsedAccount('P', 'S'));
      const payloadWord = { toFelts: () => ['f1', 'f2', 'f3', 'f4'] };
      rpoHashElements.mockReturnValueOnce(payloadWord).mockReturnValueOnce('final');

      const requestPayload = { toBytes: () => new Uint8Array([1, 2, 3]) } as never;
      AuthDigest.fromRequest('bare-no-prefix', 50, requestPayload);

      expect(accountIdFromHex).toHaveBeenCalledWith('0xbare-no-prefix');
    });

    it('short-circuits to the empty-payload Word when toBytes() returns an empty array', () => {
      accountIdFromHex.mockReturnValueOnce(makeParsedAccount('P', 'S'));
      // Empty-payload path: Word.fromHex called once with 64 zero hex chars,
      // and the result is used directly (no extra hashElements call for the payload).
      const emptyWord = { toFelts: () => ['e1', 'e2', 'e3', 'e4'] };
      wordFromHex.mockReturnValueOnce(emptyWord);
      rpoHashElements.mockReturnValueOnce('final');

      const requestPayload = { toBytes: () => new Uint8Array() } as never;

      AuthDigest.fromRequest('0xabc', 1, requestPayload);

      expect(wordFromHex).toHaveBeenCalledWith('0x' + '0'.repeat(64));
    });
  });

  describe('fromCommitmentHex', () => {
    it('pads short hex to 32 bytes when building the Word', () => {
      wordFromHex.mockReturnValueOnce('word');

      AuthDigest.fromCommitmentHex('0xabc');

      expect(wordFromHex).toHaveBeenCalledWith('0x' + 'abc'.padStart(64, '0'));
    });

    it('adds the 0x prefix when the caller forgot it', () => {
      wordFromHex.mockReturnValueOnce('word');

      AuthDigest.fromCommitmentHex('deadbeef');

      expect(wordFromHex).toHaveBeenCalledWith('0x' + 'deadbeef'.padStart(64, '0'));
    });
  });
});
