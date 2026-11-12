import { SIGN_BYTES_DOMAIN_TAG, signBytesInputs } from './domain';

// The stand-in SDK marks a Felt consumed once it is passed on, as the browser binding does, and throws on reuse.
const mockArbitraryCalls: bigint[][] = [];
const mockArbitraryHandles: { free: jest.Mock; word: { free: jest.Mock } }[] = [];
const mockFreed: object[] = [];
let mockDecoded: Record<string, unknown>;
let mockArbitraryAsArray = false;

jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  const FELT_MODULUS = 0xffffffff00000001n;
  const felt = (value: bigint) => {
    const self = {
      consumed: false,
      asInt: () => {
        if (self.consumed) throw new Error('felt already consumed');
        return value;
      },
      free: () => {
        mockFreed.push(self);
      }
    };
    return self;
  };
  const word = (values: bigint[]) => {
    const self = {
      toFelts: () => values.map(felt),
      free: () => {
        mockFreed.push(self);
      }
    };
    return self;
  };
  return {
    SigningInputsType: { TransactionSummary: 0, Arbitrary: 1, Blind: 2 },
    Felt: function Felt(value: bigint) {
      if (value < 0n || value >= FELT_MODULUS) throw new Error('not a field element');
      return felt(value);
    },
    Word: {
      deserialize: (bytes: Uint8Array) => {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return word([0, 8, 16, 24].map(at => view.getBigUint64(at, true)));
      }
    },
    SigningInputs: {
      deserialize: () => mockDecoded,
      newArbitrary: (felts: { consumed: boolean; asInt: () => bigint }[]) => {
        mockArbitraryCalls.push(felts.map(f => f.asInt()));
        felts.forEach(f => {
          f.consumed = true;
        });
        const word = { free: jest.fn() };
        const handle = { created: true, free: jest.fn(), toCommitment: () => word };
        mockArbitraryHandles.push({ free: handle.free, word });
        return handle;
      }
    }
  };
});

const words = (...values: bigint[]) => {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  values.forEach((v, i) => view.setBigUint64(8 * i, v, true));
  return bytes;
};

const mockFelt = (value: bigint) => ({ asInt: () => value, free: jest.fn() });

function decoded(variantType: number, extra: Record<string, unknown>) {
  const free = jest.fn();
  mockDecoded = { variantType, free, ...extra };
  return { free };
}

beforeEach(() => {
  mockArbitraryCalls.length = 0;
  mockArbitraryHandles.length = 0;
  mockFreed.length = 0;
  mockArbitraryAsArray = false;
});

function expectKeptWord(signed: object) {
  const handle = mockArbitraryHandles[mockArbitraryHandles.length - 1]!;
  expect(handle.free).toHaveBeenCalledTimes(1);
  expect(signed).toBe(handle.word);
  expect(handle.word.free).not.toHaveBeenCalled();
}

const valueAt = (values: bigint[], i: number): bigint => {
  const value = values[i];
  if (value === undefined) throw new Error(`no payload value at ${i}`);
  return value;
};

const arbitrary = (...values: bigint[]) =>
  decoded(1, {
    arbitraryPayload: () =>
      mockArbitraryAsArray
        ? values.map(mockFelt)
        : { length: () => values.length, get: (i: number) => mockFelt(valueAt(values, i)), free: jest.fn() }
  });

describe('signBytesInputs', () => {
  it('word: signs the tag then the word, never the word', () => {
    const signed = signBytesInputs(words(1n, 2n, 3n, 4n), 'word');
    expect(mockArbitraryCalls).toEqual([[...SIGN_BYTES_DOMAIN_TAG, 1n, 2n, 3n, 4n]]);
    expectKeptWord(signed);
  });

  it('Blind: signs the tag then the blind word', () => {
    decoded(2, { blindPayload: () => ({ toFelts: () => [1n, 2n, 3n, 4n].map(mockFelt), free: jest.fn() }) });
    const signed = signBytesInputs(new Uint8Array(), 'signingInputs');
    expect(mockArbitraryCalls).toEqual([[...SIGN_BYTES_DOMAIN_TAG, 1n, 2n, 3n, 4n]]);
    expectKeptWord(signed);
  });

  it.each([false, true])('Arbitrary: signs the tag then every element in order (plain array: %s)', asArray => {
    mockArbitraryAsArray = asArray;
    arbitrary(5n, 6n, 7n);
    const signed = signBytesInputs(new Uint8Array(), 'signingInputs');
    expect(mockArbitraryCalls).toEqual([[...SIGN_BYTES_DOMAIN_TAG, 5n, 6n, 7n]]);
    expectKeptWord(signed);
  });

  it('Arbitrary: an empty payload signs exactly the tag', () => {
    arbitrary();
    const signed = signBytesInputs(new Uint8Array(), 'signingInputs');
    expect(mockArbitraryCalls).toEqual([[...SIGN_BYTES_DOMAIN_TAG]]);
    expectKeptWord(signed);
  });

  it('TransactionSummary: returns the decoded inputs commitment and frees the inputs', () => {
    const word = { free: jest.fn() };
    const { free } = decoded(0, { toCommitment: () => word });
    expect(signBytesInputs(new Uint8Array(), 'signingInputs')).toBe(word);
    expect(mockArbitraryCalls).toEqual([]);
    expect(free).toHaveBeenCalledTimes(1);
    expect(word.free).not.toHaveBeenCalled();
  });

  it('refuses an unknown kind and an unknown variant', () => {
    expect(() => signBytesInputs(words(1n), 'other' as never)).toThrow('unsupported sign kind');
    const { free } = decoded(9, {});
    expect(() => signBytesInputs(new Uint8Array(), 'signingInputs')).toThrow('unsupported signing inputs');
    expect(free).toHaveBeenCalledTimes(1);
  });

  it('builds fresh felts on every call', () => {
    const data = words(1n, 2n, 3n, 4n);
    const first = signBytesInputs(data, 'word');
    const second = signBytesInputs(data, 'word');
    expect(mockArbitraryCalls).toHaveLength(2);
    expect(first).toBe(mockArbitraryHandles[0]!.word);
    expect(second).toBe(mockArbitraryHandles[1]!.word);
    for (const handle of mockArbitraryHandles) {
      expect(handle.free).toHaveBeenCalledTimes(1);
      expect(handle.word.free).not.toHaveBeenCalled();
    }
  });

  it('frees what it decodes, not what it returns', () => {
    const { free } = arbitrary(5n);
    const signed = signBytesInputs(new Uint8Array(), 'signingInputs');
    expect(free).toHaveBeenCalledTimes(1);
    expectKeptWord(signed);
    mockFreed.length = 0;
    const wordSigned = signBytesInputs(words(1n, 2n, 3n, 4n), 'word');
    expect(mockFreed.length).toBeGreaterThan(0);
    expectKeptWord(wordSigned);
  });

  it('the tag cannot open a transaction summary preimage', () => {
    expect(SIGN_BYTES_DOMAIN_TAG).toHaveLength(4);
    expect(SIGN_BYTES_DOMAIN_TAG[0]).not.toBe(1n);
    for (const element of SIGN_BYTES_DOMAIN_TAG) expect(element > 0xffffffffn).toBe(true);
  });
});
