import { sameCommitment } from 'lib/secure-hot-key/commitment';

export function deviceSignersAfterRevocation(
  signers: readonly string[],
  target: string,
  current: string,
  recovery: string,
  threshold: number
): string[] {
  if (!/^0x[0-9a-f]{64}$/i.test(target)) throw new Error('Invalid signer commitment');
  if (sameCommitment(target, current) || sameCommitment(target, recovery)) {
    throw new Error('Cannot revoke this device or the recovery key');
  }
  if (!signers.some(signer => sameCommitment(signer, target))) throw new Error('Signer is no longer registered');
  const remaining = signers.filter(signer => !sameCommitment(signer, target));
  if (remaining.length < threshold) throw new Error('Not enough signers remain');
  return remaining;
}
