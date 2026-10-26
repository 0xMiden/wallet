import { encodePrivateKeyPair, parsePrivateKeyPair } from './private-key-pair';

const HOT = 'ab'.repeat(32);
const EVM = '01'.repeat(32);
const ORDER = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141';

describe('private key pair transfer', () => {
  it('normalizes optional prefixes and case to exactly hot:evm', () => {
    const pair = parsePrivateKeyPair(` 0X${HOT.toUpperCase()} : 0x${EVM} `);
    expect(pair).toEqual({ hotPrivateKey: HOT, evmPrivateKey: EVM });
    expect(pair && encodePrivateKeyPair(pair)).toBe(`${HOT}:${EVM}`);
  });
  it.each(['', HOT, `${HOT}:`, `:${EVM}`, `${HOT}:${EVM}:`, `miden:${HOT}:${EVM}`])(
    'rejects missing or extra fields (%s)',
    payload => {
      expect(parsePrivateKeyPair(payload)).toBeNull();
    }
  );
  it.each(['0'.repeat(64), ORDER, 'f'.repeat(64), 'gg'.repeat(32), '1', '01' + HOT, HOT + '\n00'])(
    'rejects malformed and invalid scalars in either position (%s)',
    scalar => {
      expect(parsePrivateKeyPair(`${scalar}:${EVM}`)).toBeNull();
      expect(parsePrivateKeyPair(`${HOT}:${scalar}`)).toBeNull();
    }
  );
  it('accepts the minimum and maximum valid scalars', () => {
    const min = '1'.padStart(64, '0');
    const max = (BigInt(`0x${ORDER}`) - BigInt(1)).toString(16);
    expect(parsePrivateKeyPair(`${min}:${max}`)).toEqual({ hotPrivateKey: min, evmPrivateKey: max });
  });
});
