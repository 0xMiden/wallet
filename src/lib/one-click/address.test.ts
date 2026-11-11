/** @jest-environment node */

import {
  detectNearIntentsAddressKind,
  isValidNearIntentsAddress,
  isValidNearIntentsRefundAddress,
  normalizeNearIntentsAddress
} from './address';
import type { NearIntentsAddressKind } from './types';

// An EIP-55 test vector with a correct checksum, and the same address with one letter in the wrong case.
const CHECKSUMMED = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const BAD_CHECKSUM = '0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
// 32 bytes of 0x02: base58 of the right length, but not a point on the ed25519 curve (as a program derived address).
const OFF_CURVE = '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR';
const SOLANA_WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const NEAR_IMPLICIT = '98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de';

describe('isValidNearIntentsRefundAddress', () => {
  const accepted: [NearIntentsAddressKind, string][] = [
    ['evm', '0x52908400098527886E0F7030069857D2E4169EE7'],
    ['evm', '0xde709f2102306220921060314715629080e2fb77'],
    ['evm', BAD_CHECKSUM],
    ['solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
    ['solana', '11111111111111111111111111111111'],
    ['solana', OFF_CURVE],
    ['bitcoin', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'],
    ['bitcoin', 'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297'],
    ['bitcoin', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'],
    ['bitcoin', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'],
    ['near', 'alice.near'],
    ['near', 'app_1-x.sub.near'],
    ['near', 'ab'],
    ['near', NEAR_IMPLICIT]
  ];

  const rejected: [NearIntentsAddressKind, string, string][] = [
    ['evm', '52908400098527886E0F7030069857D2E4169EE7', 'no 0x prefix'],
    ['evm', '0x52908400098527886E0F7030069857D2E4169EE', 'too short'],
    ['evm', '0x52908400098527886E0F7030069857D2E4169EEG', 'a non-hex character'],
    ['evm', '', 'empty'],
    ['solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyT', 'too short to be 32 bytes'],
    ['solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1vEPjF', 'too long'],
    ['solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt10', 'a character outside base58'],
    ['solana', '0x52908400098527886E0F7030069857D2E4169EE7', 'an EVM address'],
    ['bitcoin', 'BC1QAR0SRRR7XFKVY5L643LYDNW9RE59GTZZWF5MDQ', 'upper case bech32'],
    ['bitcoin', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdb', 'a character outside bech32'],
    ['bitcoin', 'bc1qar0sr', 'too short'],
    ['bitcoin', 'tb1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'a testnet address'],
    ['bitcoin', '2A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'a legacy address that does not start with 1 or 3'],
    ['bitcoin', '1A1zP1eP5QGefi2DMPTfTL5SLmv7Div', 'a legacy address of the wrong length'],
    ['near', 'a', 'too short'],
    ['near', `${'a'.repeat(65)}`, 'too long'],
    ['near', 'Alice.near', 'upper case'],
    ['near', 'alice..near', 'a doubled separator'],
    ['near', '.alice', 'a separator at the start'],
    ['near', 'alice-', 'a separator at the end'],
    ['near', 'alice@near', 'a character outside the account set']
  ];

  it.each(accepted)('accepts a %s address %s', (kind, value) => {
    expect(isValidNearIntentsRefundAddress(kind, value)).toBe(true);
  });

  it.each(rejected)('rejects a %s address %s (%s)', (kind, value) => {
    expect(isValidNearIntentsRefundAddress(kind, value)).toBe(false);
  });

  it('does not accept the address of one chain for another', () => {
    expect(isValidNearIntentsRefundAddress('near', '0x52908400098527886E0F7030069857D2E4169EE7')).toBe(false);
    expect(isValidNearIntentsRefundAddress('evm', 'alice.near')).toBe(false);
    expect(isValidNearIntentsRefundAddress('bitcoin', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(false);
  });
});

describe('isValidNearIntentsAddress (destination)', () => {
  const accepted: [NearIntentsAddressKind, string][] = [
    ['evm', '0x52908400098527886E0F7030069857D2E4169EE7'],
    ['evm', '0xde709f2102306220921060314715629080e2fb77'],
    ['evm', CHECKSUMMED],
    ['solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
    ['solana', SOLANA_WALLET],
    ['bitcoin', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'],
    ['bitcoin', 'BC1QAR0SRRR7XFKVY5L643LYDNW9RE59GTZZWF5MDQ'],
    ['bitcoin', 'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297'],
    ['bitcoin', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'],
    ['bitcoin', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'],
    ['near', 'alice.near'],
    ['near', 'app_1-x.sub.near'],
    ['near', NEAR_IMPLICIT]
  ];

  const rejected: [NearIntentsAddressKind, string, string][] = [
    ['evm', BAD_CHECKSUM, 'a mixed-case address with a bad checksum'],
    ['evm', `0x${'0'.repeat(40)}`, 'the zero address'],
    ['evm', '0x52908400098527886E0F7030069857D2E4169EE', 'too short'],
    ['solana', '11111111111111111111111111111111', 'the system program'],
    ['solana', OFF_CURVE, 'a value that is not on the ed25519 curve'],
    ['solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyT', 'too short to be 32 bytes'],
    ['bitcoin', 'Bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'mixed case bech32'],
    ['bitcoin', 'tb1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'a testnet address'],
    ['near', 'ab', 'a name with no dot'],
    ['near', 'alice', 'a top-level name with no dot'],
    ['near', '0x52908400098527886E0F7030069857D2E4169EE7', 'an EVM address'],
    ['near', 'Alice.near', 'upper case']
  ];

  it.each(accepted)('accepts a %s destination %s', (kind, value) => {
    expect(isValidNearIntentsAddress(kind, value)).toBe(true);
  });

  it.each(rejected)('rejects a %s destination %s (%s)', (kind, value) => {
    expect(isValidNearIntentsAddress(kind, value)).toBe(false);
  });
});

describe('detectNearIntentsAddressKind', () => {
  it.each<[string, NearIntentsAddressKind | undefined]>([
    ['0xde709f2102306220921060314715629080e2fb77', 'evm'],
    ['0x52908400098527886E0F7030069857D2E4169EE7', 'evm'],
    [CHECKSUMMED, 'evm'],
    [BAD_CHECKSUM, undefined],
    [`0x${'0'.repeat(40)}`, undefined],
    // A `0x` value of 64 hex characters is not an EVM address and is never read as a NEAR account.
    [`0x${'a'.repeat(64)}`, undefined],
    ['bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'bitcoin'],
    ['BC1QAR0SRRR7XFKVY5L643LYDNW9RE59GTZZWF5MDQ', 'bitcoin'],
    ['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'bitcoin'],
    ['3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'bitcoin'],
    [SOLANA_WALLET, 'solana'],
    ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'solana'],
    ['11111111111111111111111111111111', undefined],
    [OFF_CURVE, undefined],
    [NEAR_IMPLICIT, 'near'],
    ['alice.near', 'near'],
    ['alice', undefined],
    ['', undefined],
    ['not an address', undefined]
  ])('reads %s as %s', (value, kind) => {
    expect(detectNearIntentsAddressKind(value)).toBe(kind);
  });

  it('gives a kind that the destination check accepts', () => {
    for (const value of [CHECKSUMMED, SOLANA_WALLET, NEAR_IMPLICIT, 'BC1QAR0SRRR7XFKVY5L643LYDNW9RE59GTZZWF5MDQ']) {
      const kind = detectNearIntentsAddressKind(value);
      expect(kind).toBeDefined();
      if (kind !== undefined) expect(isValidNearIntentsAddress(kind, value)).toBe(true);
    }
  });
});

describe('normalizeNearIntentsAddress', () => {
  it('writes an upper-case bech32 bitcoin address in lower case', () => {
    expect(normalizeNearIntentsAddress('bitcoin', ' BC1QAR0SRRR7XFKVY5L643LYDNW9RE59GTZZWF5MDQ ')).toBe(
      'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'
    );
  });

  it('keeps every other address as it is, trimmed', () => {
    expect(normalizeNearIntentsAddress('bitcoin', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe(
      '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'
    );
    expect(normalizeNearIntentsAddress('evm', ` ${CHECKSUMMED}\n`)).toBe(CHECKSUMMED);
    expect(normalizeNearIntentsAddress('solana', SOLANA_WALLET)).toBe(SOLANA_WALLET);
    expect(normalizeNearIntentsAddress('near', ' alice.near')).toBe('alice.near');
  });
});
