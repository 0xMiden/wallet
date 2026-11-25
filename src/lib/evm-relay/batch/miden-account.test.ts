/**
 * @jest-environment node
 */
import { isMidenAccountHex, midenAccountHexToEvmAddress } from './miden-account';

describe('midenAccountHexToEvmAddress', () => {
  it('puts the 15-byte id between 4 zero bytes and 1 zero byte, in lower case', () => {
    expect(midenAccountHexToEvmAddress(`0x${'0A'.repeat(15)}`)).toBe(`0x00000000${'0a'.repeat(15)}00`);
    expect(midenAccountHexToEvmAddress('0x0123456789abcdef0123456789abcd')).toBe(
      '0x000000000123456789abcdef0123456789abcd00'
    );
  });

  it.each(['0x1234', `0x${'0a'.repeat(16)}`, '0a'.repeat(15), `0x${'zz'.repeat(15)}`, ''])('refuses %p', value => {
    expect(isMidenAccountHex(value)).toBe(false);
    expect(() => midenAccountHexToEvmAddress(value)).toThrow('not a 15-byte');
  });
});
