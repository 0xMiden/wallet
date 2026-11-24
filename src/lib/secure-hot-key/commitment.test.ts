import { u8ToB64 } from 'lib/shared/helpers';

import { commitmentToHex, sameCommitment } from './commitment';

describe('commitmentToHex', () => {
  const HEX = '0123456789abcdef'.repeat(4);
  const bytes = (length: number) => new Uint8Array(length).fill(0x5a);

  it.each([
    ['bare lowercase hex', HEX],
    ['bare uppercase hex', HEX.toUpperCase()],
    ['0x-prefixed hex', `0x${HEX}`],
    ['0X-prefixed uppercase hex', `0X${HEX.toUpperCase()}`],
    ['base64 of the 32 bytes', u8ToB64(new Uint8Array(Buffer.from(HEX, 'hex')))]
  ])('reads %s as lowercase hex', (_form, value) => {
    expect(commitmentToHex(value)).toBe(HEX);
  });

  it.each([
    ['an empty string', ''],
    ['hex a nibble short', HEX.slice(1)],
    ['hex a byte long', `${HEX}00`],
    ['base64 of 31 bytes', u8ToB64(bytes(31))],
    ['base64 of 33 bytes', u8ToB64(bytes(33))],
    ['text that is neither', 'not a commitment'],
    ['a missing value', undefined]
  ])('refuses %s', (_form, value) => {
    expect(commitmentToHex(value)).toBeUndefined();
  });
});

/**
 * `sameCommitment` decides whether the device still owns a guardian account, so
 * a false negative there stops a legitimate self-heal and a false positive lets
 * a rotated-out device revoke the device that now owns the account. The inputs
 * come from two different producers (on-chain storage reads vs the SDK's
 * `toCommitment().toHex()`), which disagree on 0x-prefixing, case, and leading
 * zero padding — so the normalisation is the whole point.
 */
describe('sameCommitment', () => {
  it('ignores the 0x prefix on either side', () => {
    expect(sameCommitment('0xabc123', 'abc123')).toBe(true);
    expect(sameCommitment('abc123', '0xabc123')).toBe(true);
  });

  it('ignores case', () => {
    expect(sameCommitment('0xABC123', '0xabc123')).toBe(true);
  });

  it('ignores leading zero padding', () => {
    // Storage reads come back padded to a full word; the SDK does not pad.
    expect(sameCommitment(`0x${'0'.repeat(40)}abc123`, '0xabc123')).toBe(true);
  });

  it('does not treat different commitments as equal', () => {
    expect(sameCommitment('0xabc123', '0xabc124')).toBe(false);
  });

  it('does not collapse a real commitment into the empty word', () => {
    // An all-zero word is how an absent signer slot reads back; it must never
    // compare equal to a real key.
    expect(sameCommitment(`0x${'0'.repeat(64)}`, '0xabc123')).toBe(false);
  });
});
