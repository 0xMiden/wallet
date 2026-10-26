/**
 * Normalization + deserialization for a user-pasted Guardian HOT secret key.
 *
 * The wallet reveals a hot key as the raw 32-byte secp256k1 scalar hex
 * (`serialize().slice(1)` — see `lib/secure-hot-key/jsFallback.revealHotKey`),
 * while the SDK's `AuthSecretKey.deserialize` wants the full serialized blob
 * with its 1-byte scheme tag. A user importing a key may reasonably paste
 * either form (with or without a `0x` prefix), so both are accepted here and
 * canonicalized to the full serialized form.
 *
 * Frontend-safe: the only WASM touched is static `AuthSecretKey` construction,
 * same as `discover.ts`. Deliberately does NOT import `lib/miden/sdk/miden-client`.
 */
import { AuthSecretKey } from '@miden-sdk/miden-sdk/lazy';
import { Buffer } from 'buffer';

/** Raw scalar form — what `Vault.revealHotKey` shows the user. */
export const HOT_KEY_SCALAR_HEX_LEN = 64;
/** Full `AuthSecretKey.serialize()` form — scheme tag byte + scalar. */
export const HOT_KEY_SERIALIZED_HEX_LEN = 66;

/**
 * Clean a pasted hot-key string down to bare lowercase hex of one of the two
 * accepted lengths, or `null` when it can't be a hot key. Pure string work —
 * safe to run per keystroke in the paste screen.
 */
export function normalizeHotSecretKeyHex(input: string): string | null {
  const cleaned = input.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]+$/.test(cleaned)) return null;
  if (cleaned.length !== HOT_KEY_SCALAR_HEX_LEN && cleaned.length !== HOT_KEY_SERIALIZED_HEX_LEN) return null;
  return cleaned;
}

/**
 * The scheme tag byte an ECDSA `AuthSecretKey` serializes under, read from the
 * SDK itself rather than hardcoded: serialize a throwaway deterministic key
 * once and take its leading byte. (`ECDSA_SIGNATURE_SCHEME_TAG` in vault.ts is
 * the SIGNATURE tag — the key tag is a separate enum and must not be assumed.)
 */
let cachedEcdsaKeyTagHex: string | undefined;
export function ecdsaSecretKeyTagHex(): string {
  if (cachedEcdsaKeyTagHex !== undefined) return cachedEcdsaKeyTagHex;
  const probe = AuthSecretKey.ecdsaWithRNG(new Uint8Array(32).fill(1));
  try {
    cachedEcdsaKeyTagHex = Buffer.from(probe.serialize().slice(0, 1)).toString('hex');
  } finally {
    try {
      probe.free();
    } catch {
      // Already freed / stubbed handle — nothing to release.
    }
  }
  return cachedEcdsaKeyTagHex;
}

/**
 * Deserialize a normalized hot-key hex (either accepted form) into an
 * `AuthSecretKey`. The caller owns the returned WASM handle and must `free()`
 * it. Throws on anything `normalizeHotSecretKeyHex` rejects or the SDK cannot
 * decode.
 */
export function deserializeHotSecretKey(input: string): AuthSecretKey {
  const cleaned = normalizeHotSecretKeyHex(input);
  if (!cleaned) throw new Error('Invalid hot key hex');
  const full = cleaned.length === HOT_KEY_SCALAR_HEX_LEN ? ecdsaSecretKeyTagHex() + cleaned : cleaned;
  return AuthSecretKey.deserialize(new Uint8Array(Buffer.from(full, 'hex')));
}
