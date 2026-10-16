import { isValidChainAddress } from './chain-address';

const SOLANA = '9fYLFVoVqwH37C3dyPi6cpeobfbQ2jtLpN5HgAYDDdkm';
const EVM = '0x52908400098527886E0F7030069857D2E4169EE7';

it('validates the selected family and trims whitespace', () => {
  expect(isValidChainAddress(` ${SOLANA} `, 'solana')).toBe(true);
  expect(isValidChainAddress(SOLANA, 'evm')).toBe(false);
  expect(isValidChainAddress(EVM, 'solana')).toBe(false);
  expect(isValidChainAddress(` ${EVM} `, 'evm')).toBe(true);
});

it.each(['', '0'.repeat(32), 'O'.repeat(44), '1'.repeat(31), '1'.repeat(33), 'z'.repeat(44), SOLANA + 'x'])(
  'rejects invalid Base58 or byte length: %s',
  value => {
    expect(isValidChainAddress(value, 'solana')).toBe(false);
  }
);

it('keeps the existing EVM checksum rules', () => {
  expect(isValidChainAddress(EVM.toLowerCase(), 'evm')).toBe(true);
  expect(isValidChainAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', 'evm')).toBe(true);
  expect(isValidChainAddress('0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed', 'evm')).toBe(false);
  expect(isValidChainAddress('0x1234', 'evm')).toBe(false);
});
