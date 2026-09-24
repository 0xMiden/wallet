import { englishWordlist, generateMnemonic, mnemonicToSeed, validateMnemonic } from './mnemonic';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('mnemonic helpers', () => {
  it('exposes the 2048-word English list', () => {
    expect(englishWordlist).toHaveLength(2048);
    expect(englishWordlist[0]).toBe('abandon');
    expect(englishWordlist[2047]).toBe('zoo');
  });

  it('generates a valid 12-word phrase', () => {
    const phrase = generateMnemonic();
    expect(phrase.split(' ')).toHaveLength(12);
    expect(validateMnemonic(phrase)).toBe(true);
    expect(generateMnemonic()).not.toBe(phrase);
  });

  it('validates the checksum', () => {
    expect(validateMnemonic(MNEMONIC)).toBe(true);
    expect(validateMnemonic(MNEMONIC.replace(/about$/u, 'abandon'))).toBe(false);
    expect(validateMnemonic('not a phrase')).toBe(false);
  });

  it('gives the BIP-39 reference seed for the test phrase', () => {
    const seed = mnemonicToSeed(MNEMONIC);
    expect(seed).toHaveLength(64);
    expect(Array.from(seed.slice(0, 8), b => b.toString(16).padStart(2, '0')).join('')).toBe('5eb00bbddcf06908');
  });
});
