/* eslint-disable import/first -- the jest.mock() factory must be registered before the module under test is imported. */
const mockDeserialize = jest.fn();

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  SigningInputs: { deserialize: (bytes: Uint8Array) => mockDeserialize(bytes) },
  SigningInputsType: { TransactionSummary: 0, Arbitrary: 1, Blind: 2 }
}));

import { u8ToB64 } from 'lib/shared/helpers';

import { signableArbitraryElements } from './dapp-sign-inputs';
import {
  GUARDIAN_LOOKUP_DOMAIN_TAG,
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

  it('refuses an Arbitrary preimage with a protocol message layout and frees the inputs', () => {
    const { inputs, array } = signingInputs(1, [...GUARDIAN_LOOKUP_DOMAIN_TAG, 1n, 2n, 3n, 4n, 5n]);
    mockDeserialize.mockReturnValue(inputs);

    expect(signableArbitraryElements('signingInputs', PAYLOAD)).toBeUndefined();
    expect(inputs.free).toHaveBeenCalledTimes(1);
    expect(array.free).toHaveBeenCalledTimes(1);
  });
});

describe('isProtocolMessageLayout', () => {
  const summaryLayout = (first: bigint) =>
    Array.from({ length: TRANSACTION_SUMMARY_ELEMENT_COUNT }, (_, index) => (index === 0 ? first : 9n));

  it.each([
    ['24 elements whose first element is version 1', summaryLayout(1n), true],
    ['24 elements whose first element is not 1', summaryLayout(2n), false],
    ['9 elements that start with the Guardian lookup tag', [...GUARDIAN_LOOKUP_DOMAIN_TAG, 0n, 0n, 0n, 0n, 0n], true],
    ['9 elements that start with another tag', [0n, ...GUARDIAN_LOOKUP_DOMAIN_TAG.slice(1), 0n, 0n, 0n, 0n, 0n], false],
    ['the lookup tag in a message of another length', [...GUARDIAN_LOOKUP_DOMAIN_TAG, 0n], false],
    ['an empty preimage', [], false],
    ['a short preimage that starts with 1', [1n, 2n, 3n], false]
  ])('%s: %s', (_label, elements, expected) => {
    expect(isProtocolMessageLayout(elements)).toBe(expected);
  });
});
