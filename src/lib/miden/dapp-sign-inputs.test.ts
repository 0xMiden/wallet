/* eslint-disable import/first -- the jest.mock() factory must be registered before the module under test is imported. */
const mockDeserialize = jest.fn();
/** The stand-in lookup tag that the mocked hash returns. */
const mockTag = [91n, 92n, 93n, 94n];
const mockTagFelts = mockTag.map(value => ({ asInt: () => value, free: jest.fn() }));
const mockTagWord = { toFelts: () => mockTagFelts, free: jest.fn() };
const mockHashElements = jest.fn((_preimage: { elements: { value: bigint }[] }) => mockTagWord);

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  Felt: class {
    constructor(readonly value: bigint) {}
  },
  FeltArray: class {
    constructor(readonly elements: { value: bigint }[]) {}
  },
  Rpo256: { hashElements: (preimage: { elements: { value: bigint }[] }) => mockHashElements(preimage) },
  SigningInputs: { deserialize: (bytes: Uint8Array) => mockDeserialize(bytes) },
  SigningInputsType: { TransactionSummary: 0, Arbitrary: 1, Blind: 2 }
}));

import { u8ToB64 } from 'lib/shared/helpers';

import { protocolTags, signableArbitraryElements } from './dapp-sign-inputs';
import {
  domainTagPreimage,
  GUARDIAN_LOOKUP_DOMAIN_STRING,
  isProtocolMessageLayout,
  TRANSACTION_SUMMARY_ELEMENT_COUNT
} from './dapp-sign-rule';

const PAYLOAD = u8ToB64(new Uint8Array([1, 2, 3]));

/** Signing inputs of `variantType` whose elements are `values`, with a `free` spy on every object. */
const signingInputs = (variantType: number, values: readonly bigint[] = []) => {
  const felts = values.map(value => ({ asInt: jest.fn(() => value), free: jest.fn() }));
  const array = { length: jest.fn(() => felts.length), get: jest.fn((index: number) => felts[index]), free: jest.fn() };
  const inputs = { variantType, toElements: jest.fn(() => array), free: jest.fn() };
  return { inputs, array, felts };
};

beforeEach(() => {
  mockDeserialize.mockReset();
});

describe('domainTagPreimage', () => {
  it('packs the domain as 8-byte little-endian elements, the last one padded with zeros', () => {
    const word = (text: string) => Buffer.from(text.padEnd(8, '\0'), 'latin1').readBigUInt64LE(0);
    expect(domainTagPreimage(GUARDIAN_LOOKUP_DOMAIN_STRING)).toEqual([word('guardian'), word('.lookup.'), word('v1')]);
  });
});

describe('protocolTags', () => {
  it('hashes the packed lookup domain once, caches the tag and frees the hash result', () => {
    const tags = protocolTags();

    expect(tags.guardianLookup).toEqual(mockTag);
    expect(mockHashElements).toHaveBeenCalledTimes(1);
    const [preimage] = mockHashElements.mock.calls[0]!;
    expect(preimage.elements.map(felt => felt.value)).toEqual(domainTagPreimage(GUARDIAN_LOOKUP_DOMAIN_STRING));
    expect(mockTagWord.free).toHaveBeenCalledTimes(1);
    mockTagFelts.forEach(felt => expect(felt.free).toHaveBeenCalledTimes(1));

    expect(protocolTags()).toBe(tags);
    expect(mockHashElements).toHaveBeenCalledTimes(1);
  });
});

describe('signableArbitraryElements', () => {
  it('returns the preimage of Arbitrary signing inputs and frees every SDK object', () => {
    const { inputs, array, felts } = signingInputs(1, [7n, 8n]);
    mockDeserialize.mockReturnValue(inputs);

    expect(signableArbitraryElements('signingInputs', PAYLOAD)).toEqual([7n, 8n]);
    expect(mockDeserialize).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
    expect(inputs.free).toHaveBeenCalledTimes(1);
    expect(array.free).toHaveBeenCalledTimes(1);
    felts.forEach(felt => expect(felt.free).toHaveBeenCalledTimes(1));
  });

  it.each([
    ['TransactionSummary', 0],
    ['Blind', 2]
  ])('refuses the %s variant and frees the inputs', (_label, variantType) => {
    const { inputs } = signingInputs(variantType);
    mockDeserialize.mockReturnValue(inputs);

    expect(signableArbitraryElements('signingInputs', PAYLOAD)).toBeUndefined();
    expect(inputs.toElements).not.toHaveBeenCalled();
    expect(inputs.free).toHaveBeenCalledTimes(1);
  });

  it('refuses the word kind without reading the payload', () => {
    expect(signableArbitraryElements('word', PAYLOAD)).toBeUndefined();
    expect(mockDeserialize).not.toHaveBeenCalled();
  });

  it('refuses a payload that does not deserialize', () => {
    mockDeserialize.mockImplementation(() => {
      throw new Error('bad bytes');
    });
    expect(signableArbitraryElements('signingInputs', PAYLOAD)).toBeUndefined();
  });

  it('refuses an Arbitrary preimage that starts with the derived lookup tag and frees the inputs', () => {
    const { inputs, array } = signingInputs(1, [...mockTag, 1n, 2n, 3n, 4n, 5n]);
    mockDeserialize.mockReturnValue(inputs);

    expect(signableArbitraryElements('signingInputs', PAYLOAD)).toBeUndefined();
    expect(inputs.free).toHaveBeenCalledTimes(1);
    expect(array.free).toHaveBeenCalledTimes(1);
  });

  it('refuses every request when the lookup tag cannot be derived', () => {
    mockHashElements.mockImplementationOnce(() => {
      throw new Error('no WASM');
    });
    jest.isolateModules(() => {
      const isolated: typeof import('./dapp-sign-inputs') = require('./dapp-sign-inputs');
      mockDeserialize.mockReturnValue(signingInputs(1, [7n, 8n]).inputs);
      expect(isolated.signableArbitraryElements('signingInputs', PAYLOAD)).toBeUndefined();
    });
  });
});

describe('isProtocolMessageLayout', () => {
  const tags = { guardianLookup: mockTag };
  const summaryLayout = (first: bigint) =>
    Array.from({ length: TRANSACTION_SUMMARY_ELEMENT_COUNT }, (_, index) => (index === 0 ? first : 9n));

  it.each([
    ['24 elements whose first element is version 1', summaryLayout(1n), true],
    ['24 elements whose first element is not 1', summaryLayout(2n), false],
    ['9 elements that start with the Guardian lookup tag', [...mockTag, 0n, 0n, 0n, 0n, 0n], true],
    ['9 elements that start with another tag', [0n, ...mockTag.slice(1), 0n, 0n, 0n, 0n, 0n], false],
    ['the lookup tag in a message of another length', [...mockTag, 0n], false],
    ['an empty preimage', [], false],
    ['a short preimage that starts with 1', [1n, 2n, 3n], false]
  ])('%s: %s', (_label, elements, expected) => {
    expect(isProtocolMessageLayout(elements, tags)).toBe(expected);
  });
});
