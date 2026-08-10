import {
  detectAddressChain,
  isHexAddress,
  isValidEthereumAddress,
  isValidMidenAddress,
  isValidRecipientAddress
} from './miden';

describe('Miden and Ethereum address utilities', () => {
  it('recognizes supported Miden network prefixes', () => {
    expect(isValidMidenAddress('mm1account')).toBe(true);
    expect(isValidMidenAddress('mtst1account')).toBe(true);
    expect(isValidMidenAddress('mdev1account')).toBe(true);
    expect(isValidMidenAddress('mlcl1account')).toBe(true); // localnet
    expect(isValidMidenAddress('unknown1account')).toBe(false);
  });

  it('validates complete uniform-case Ethereum addresses after trimming whitespace', () => {
    const address = `0x${'a1'.repeat(20)}`;
    expect(isValidEthereumAddress(`  ${address}  `)).toBe(true);
    expect(isValidEthereumAddress(`0x${'A1'.repeat(20)}`)).toBe(true);
    expect(isValidEthereumAddress('0x1234')).toBe(false);
    expect(isValidEthereumAddress(`0x${'z'.repeat(40)}`)).toBe(false);
  });

  it('requires a valid EIP-55 checksum for mixed-case Ethereum addresses', () => {
    expect(isValidEthereumAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')).toBe(true);
    expect(isValidEthereumAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD')).toBe(false);
  });

  it('accepts either supported recipient-address format', () => {
    expect(isValidRecipientAddress('mtst1account')).toBe(true);
    expect(isValidRecipientAddress(`0x${'12'.repeat(20)}`)).toBe(true);
    expect(isValidRecipientAddress('not-an-address')).toBe(false);
  });

  it('detects Ethereum recipients from the hex prefix and defaults to Miden', () => {
    expect(isHexAddress('0xabc')).toBe(true);
    expect(isHexAddress('mtst1abc')).toBe(false);
    expect(detectAddressChain('  0xabc')).toBe('ethereum');
    expect(detectAddressChain('')).toBe('miden');
    expect(detectAddressChain('mtst1abc')).toBe('miden');
  });
});
