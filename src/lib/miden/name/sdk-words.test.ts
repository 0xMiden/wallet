import { MIDEN_NAME_COMMITMENT_TAG, encodeDomainFelts } from './encoding';
import {
  accountIdFromParts,
  accountKey,
  decodeAccountWord,
  domainCommitment,
  feltsFromWord,
  idPartsFromHex,
  priceKey,
  statusKey,
  statusKeyFeltsForLabel,
  wordHexFromFelts
} from './sdk-words';
import { KNOWN_ACCOUNTS, Poseidon2, Word } from './test-support/fake-sdk';

jest.mock('@miden-sdk/miden-sdk/lazy', () => jest.requireActual('lib/miden/name/test-support/fake-sdk'));

const REGISTRY = { prefix: 0xaan, suffix: 0xbbn };

describe('sdk-words', () => {
  it('hashes the 12-felt preimage with Poseidon2', () => {
    const commitment = domainCommitment('miden', REGISTRY);
    const elements = Poseidon2.hashElements.mock.calls[0]?.[0].elements.map(felt => felt.value);
    expect(elements).toEqual([
      ...MIDEN_NAME_COMMITMENT_TAG,
      ...encodeDomainFelts('miden'),
      0n,
      0n,
      REGISTRY.suffix,
      REGISTRY.prefix
    ]);
    expect(commitment).toHaveLength(4);
    expect(statusKeyFeltsForLabel('miden', REGISTRY)).toEqual([commitment[0], commitment[1], 0n, 0n]);
  });

  it('builds key words in the encoding layouts', () => {
    const token = { prefix: 3n, suffix: 4n };
    expect(feltsFromWord(priceKey(8, token))).toEqual([5n, 0n, 4n, 3n]);
    expect(feltsFromWord(accountKey(token))).toEqual([0n, 0n, 4n, 3n]);
    expect(feltsFromWord(statusKey('miden', REGISTRY))).toEqual(statusKeyFeltsForLabel('miden', REGISTRY));
    expect(wordHexFromFelts([1n, 0n, 0n, 0n])).toBe(new Word(BigUint64Array.from([1n, 0n, 0n, 0n])).toHex());
  });

  it('refuses a word that does not have 4 felts', () => {
    Poseidon2.hashElements.mockReturnValueOnce(new Word(BigUint64Array.from([1n, 2n])));
    expect(() => domainCommitment('miden', REGISTRY)).toThrow(/4 felts/);
  });

  it('decodes account value words', () => {
    expect(decodeAccountWord([0n, 0n, 0n, 0n])).toBeNull();
    expect(decodeAccountWord([1n, 0n, 2n, 3n])).toBeNull();
    expect(decodeAccountWord([0n, 1n, 2n, 3n])).toBeNull();
    expect(decodeAccountWord([0n, 0n, 2n, 3n])).toEqual({ prefix: 3n, suffix: 2n });
  });

  it('converts account ids and parts', () => {
    KNOWN_ACCOUNTS.set('0xreg', REGISTRY);
    expect(idPartsFromHex('0xREG')).toEqual(REGISTRY);
    expect(accountIdFromParts({ prefix: 7n, suffix: 8n }).toString()).toBe('0xacc7');
  });
});
