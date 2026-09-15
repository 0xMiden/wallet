/**
 * @jest-environment node
 */
import { createHash, randomBytes } from 'crypto';

import { solvePow } from './public-faucet';

function hashBelowTarget(challengeHex: string, nonce: number, target: bigint): boolean {
  const nonceBytes = Buffer.alloc(8);
  nonceBytes.writeBigUInt64BE(BigInt(nonce));
  const digest = createHash('sha256')
    .update(Buffer.concat([Buffer.from(challengeHex, 'hex'), nonceBytes]))
    .digest();
  return digest.readBigUInt64BE(0) < target;
}

describe('solvePow', () => {
  it('returns a nonce whose hash is below the target', async () => {
    const challenge = randomBytes(32).toString('hex');
    const target = 1n << 52n; // about 4,096 expected hashes

    const nonce = await solvePow(challenge, target);

    expect(hashBelowTarget(challenge, nonce, target)).toBe(true);
  });

  it('accepts a 0x-prefixed challenge', async () => {
    const challenge = randomBytes(32).toString('hex');
    const target = 1n << 60n;

    const nonce = await solvePow(`0x${challenge}`, target);

    expect(hashBelowTarget(challenge, nonce, target)).toBe(true);
  });

  it('gives up on an unsatisfiable target once its deadline passes', async () => {
    await expect(solvePow(randomBytes(32).toString('hex'), 0n, 50)).rejects.toThrow(
      'Public faucet PoW unsolved within 50ms (target=0)'
    );
  });

  it('lets a due timer run before it gives up, however slow its first slice is', async () => {
    let timerRan = false;
    setTimeout(() => {
      timerRan = true;
    }, 0);

    // A deadline of 0 has passed by the end of the first slice, so only the yield between slices can let the
    // timer run before the rejection.
    await expect(solvePow(randomBytes(32).toString('hex'), 0n, 0)).rejects.toThrow('unsolved');
    expect(timerRan).toBe(true);
  });
});
