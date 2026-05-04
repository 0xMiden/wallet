/**
 * Native plugin path for the secure-hot-key facade. iOS lands in Phase 4 of
 * the 3-key migration (this commit); Android lands in Phase 4b and still
 * throws so failures stay loud and traceable to that follow-up.
 *
 * Native side returns only ciphertext + raw k256 publicKeyHex (the SE blob
 * embeds its own tag). The commitmentHex needed by MultisigClient.create is
 * derived here via the SDK so the GeneratedHotKey shape matches jsFallback.
 */

import { Buffer } from 'buffer';

import { isAndroid, isIOS } from 'lib/platform';

import { HotKey } from './hotKeyPlugin';
import type { GeneratedHotKey } from './jsFallback';

const ANDROID_NOT_IMPLEMENTED =
  'secure-hot-key Android native plugin not yet implemented — Phase 4b of the 3-key migration adds the StrongBox bridge';

export async function generateHotKey(): Promise<GeneratedHotKey> {
  if (isAndroid()) {
    throw new Error(ANDROID_NOT_IMPLEMENTED);
  }
  if (!isIOS()) {
    throw new Error('secure-hot-key native plugin invoked outside iOS/Android');
  }

  const { ciphertext, publicKeyHex } = await HotKey.generateHotKey();
  const commitmentHex = await commitmentFromPublicKeyHex(publicKeyHex);
  return { ciphertext, publicKeyHex, commitmentHex };
}

export async function signHotDigest(ciphertext: string, wordHex: string): Promise<string> {
  if (isAndroid()) {
    throw new Error(ANDROID_NOT_IMPLEMENTED);
  }
  if (!isIOS()) {
    throw new Error('secure-hot-key native plugin invoked outside iOS/Android');
  }

  const { signatureHex } = await HotKey.signWithHotKey({
    ciphertext,
    digestHex: wordHex
  });
  return signatureHex;
}

export async function deleteHotKey(ciphertext: string): Promise<void> {
  if (isAndroid()) {
    throw new Error(ANDROID_NOT_IMPLEMENTED);
  }
  if (!isIOS()) {
    throw new Error('secure-hot-key native plugin invoked outside iOS/Android');
  }

  await HotKey.deleteHotKey({ ciphertext });
}

async function commitmentFromPublicKeyHex(publicKeyHex: string): Promise<string> {
  const { PublicKey } = await import('@miden-sdk/miden-sdk/lazy');
  const raw = Buffer.from(publicKeyHex, 'hex');
  const framed = new Uint8Array(raw.length + 1);
  console.log(`raw public key ${publicKeyHex} for commitment derivation`);
  if (raw.length !== 33) {
    throw new Error(`unexpected public key length ${raw.length} (expected 33)`);
  }
  framed[0] = 1; // uncompressed k256 pubkey tag
  framed.set(raw, 1);
  return PublicKey.deserialize(framed).toCommitment().toHex();
}
