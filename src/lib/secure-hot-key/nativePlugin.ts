/**
 * Native plugin path for the secure-hot-key facade. Wired up in Phase 4 of the
 * 3-key migration. Until then, mobile builds fall back to throwing clearly so
 * the gap is visible during testing rather than silently degrading.
 */

import type { GeneratedHotKey } from './jsFallback';

const NOT_IMPLEMENTED =
  'secure-hot-key native plugin not yet implemented — Phase 4 of the 3-key migration adds the iOS/Android bridges';

export async function generateHotKey(): Promise<GeneratedHotKey> {
  throw new Error(NOT_IMPLEMENTED);
}

export async function signHotDigest(_ciphertext: string, _wordHex: string): Promise<string> {
  throw new Error(NOT_IMPLEMENTED);
}

export async function deleteHotKey(_ciphertext: string): Promise<void> {
  throw new Error(NOT_IMPLEMENTED);
}
