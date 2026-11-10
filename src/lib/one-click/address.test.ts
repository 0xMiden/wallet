/** @jest-environment node */

import { isValidNearIntentsAddress } from './address';
import type { NearIntentsAddressKind } from './types';

const accepted: [NearIntentsAddressKind, string][] = [
  ['evm', '0x52908400098527886E0F7030069857D2E4169EE7'],
  ['evm', '0xde709f2102306220921060314715629080e2fb77'],
  ['solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
  ['solana', '11111111111111111111111111111111'],
  ['bitcoin', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'],
  ['bitcoin', 'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297'],
  ['bitcoin', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'],
  ['bitcoin', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'],
  ['near', 'alice.near'],
  ['near', 'app_1-x.sub.near'],
  ['near', 'ab'],
  ['near', '98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de']
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

describe('isValidNearIntentsAddress', () => {
  it.each(accepted)('accepts a %s address %s', (kind, value) => {
    expect(isValidNearIntentsAddress(kind, value)).toBe(true);
  });

  it.each(rejected)('rejects a %s address %s (%s)', (kind, value) => {
    expect(isValidNearIntentsAddress(kind, value)).toBe(false);
  });

  it('does not accept the address of one chain for another', () => {
    expect(isValidNearIntentsAddress('near', '0x52908400098527886E0F7030069857D2E4169EE7')).toBe(false);
    expect(isValidNearIntentsAddress('evm', 'alice.near')).toBe(false);
    expect(isValidNearIntentsAddress('bitcoin', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(false);
  });
});
