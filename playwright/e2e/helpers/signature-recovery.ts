import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

/**
 * The one verification step outside the SDK: `PublicKey.recoverFrom` is Falcon-only (miden_client_web.d.ts:3984-3987)
 * and every wallet key is ECDSA, so the driver recovers the secp256k1 key and the page verifies with the SDK.
 * Layout (miden-protocol account/auth.rs, miden-crypto ecdsa_k256_keccak): a serialized Signature is
 * [scheme tag, r(32), s(32), v(1)], the signed digest is keccak256 of the 32 word bytes, and a serialized PublicKey
 * is [scheme tag, 33-byte compressed point]. The vector file comes from the spike's page-generated key.
 */
export const ECDSA_SCHEME_TAG = 0x01;

/** The serialized SDK `PublicKey` (base64) that produced `signatureB64` over the 32-byte word `messageB64`. */
export function recoverEcdsaPublicKey(signatureB64: string, messageB64: string): string {
  const signature = Buffer.from(signatureB64, 'base64');
  const message = Buffer.from(messageB64, 'base64');
  if (signature.length !== 66 || signature[0] !== ECDSA_SCHEME_TAG) {
    throw new Error(`not an ECDSA signature: ${signature.length} bytes, scheme tag ${signature[0]}`);
  }
  if (message.length !== 32) throw new Error(`a signed word is 32 bytes, got ${message.length}`);
  const recovery = signature[65] ?? 4;
  if (recovery > 3) throw new Error(`recovery id ${recovery} is out of range`);
  const point = secp256k1.Signature.fromCompact(signature.subarray(1, 65))
    .addRecoveryBit(recovery)
    .recoverPublicKey(keccak_256(message));
  return Buffer.from([ECDSA_SCHEME_TAG, ...point.toRawBytes(true)]).toString('base64');
}
