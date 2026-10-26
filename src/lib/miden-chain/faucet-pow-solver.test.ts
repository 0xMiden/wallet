import { createHash } from 'crypto';

import { findPowNonce } from './faucet-pow-solver';

it('solves using challenge bytes followed by a big-endian u64 safe integer nonce', async () => {
  const hex = '00112233445566778899aabbccddeeff';
  const target = 2n ** 62n;
  const nonce = await findPowNonce(`0x${hex}`, target);
  expect(Number.isSafeInteger(nonce)).toBe(true);
  expect(nonce).toBeGreaterThanOrEqual(0);
  const nonceBytes = Buffer.alloc(8);
  nonceBytes.writeBigUInt64BE(BigInt(nonce));
  const digest = createHash('sha256').update(Buffer.from(hex, 'hex')).update(nonceBytes).digest();
  expect(digest.readBigUInt64BE()).toBeLessThan(target);
});
