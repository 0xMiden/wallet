import { sameCommitment } from './commitment';

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
