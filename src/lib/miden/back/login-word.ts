/** The Miden field modulus, 2^64 - 2^32 + 1. A word element must be strictly below it. */
export const FIELD_MODULUS = 0xffffffff00000001n;

/**
 * Whether `bytes` is a serialized word: 32 bytes holding four little-endian u64s, each strictly below 0xffffffff00000001.
 * Plain JavaScript, so a request can be refused before any prompt or key read without loading WASM.
 */
export function isFieldWord(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset < 32; offset += 8) {
    if (view.getBigUint64(offset, true) >= FIELD_MODULUS) return false;
  }
  return true;
}
