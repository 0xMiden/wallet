/**
 * The hot key's COMMITMENT, derived from its serialized public key.
 *
 * Two things speak different languages about the same key: a `WalletAccount`
 * stores `hotPublicKey` (the 33-byte compressed public key, hex), while the
 * account's on-chain signer slots and the guardian's request-auth allowlist both
 * hold COMMITMENTS. Anything that has to answer "is this device still a signer
 * of that account?" needs this bridge.
 *
 * Lives on its own so the guardian sync path can use it without importing the
 * mobile-only native hot-key plugin (which asserts `isMobile()` on load).
 */
import { Buffer } from 'buffer';

export async function commitmentFromPublicKeyHex(publicKeyHex: string): Promise<string> {
  const { PublicKey } = await import('@miden-sdk/miden-sdk/lazy');
  const unprefixed = publicKeyHex.startsWith('0x') ? publicKeyHex.slice(2) : publicKeyHex;
  const raw = Buffer.from(unprefixed, 'hex');
  if (raw.length !== 33) {
    throw new Error(`unexpected public key length ${raw.length} (expected 33)`);
  }
  const framed = new Uint8Array(raw.length + 1);
  framed[0] = 1; // ECDSA k256 type prefix expected by PublicKey.deserialize
  framed.set(raw, 1);
  return PublicKey.deserialize(framed).toCommitment().toHex();
}

/** Commitments come back both 0x-prefixed and bare, and case varies by source. */
export function sameCommitment(a: string, b: string): boolean {
  const strip = (h: string): string => (h.startsWith('0x') ? h.slice(2) : h).toLowerCase().replace(/^0+/, '');
  return strip(a) === strip(b);
}
