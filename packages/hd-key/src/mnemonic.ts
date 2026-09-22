/**
 * BIP-39 mnemonic helpers. The wordlist is always English.
 *
 * `@scure/bip39` normalizes the phrase with NFKD. It then runs
 * PBKDF2-HMAC-SHA512 with 2048 rounds and the `mnemonic` salt. The `bip39`
 * package the wallet used before did the same. Thus the 64-byte master seed
 * is identical for the same phrase.
 */
import {
  generateMnemonic as scureGenerateMnemonic,
  mnemonicToSeedSync,
  validateMnemonic as scureValidateMnemonic
} from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

const MNEMONIC_STRENGTH_BITS = 128;

export const englishWordlist: readonly string[] = wordlist;

/** Generate a 12-word English mnemonic (128 bits of entropy). */
export function generateMnemonic(): string {
  return scureGenerateMnemonic(wordlist, MNEMONIC_STRENGTH_BITS);
}

/** Return true when the phrase has valid English words and a valid checksum. */
export function validateMnemonic(mnemonic: string): boolean {
  return scureValidateMnemonic(mnemonic, wordlist);
}

/** Return the 64-byte BIP-39 master seed for the phrase, with an empty passphrase. */
export function mnemonicToSeed(mnemonic: string): Uint8Array {
  return mnemonicToSeedSync(mnemonic);
}
