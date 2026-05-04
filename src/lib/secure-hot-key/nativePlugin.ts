/**
 * Native plugin path for the secure-hot-key facade. iOS landed in Phase 4a of
 * the 3-key migration (Secure Enclave-wrapped k256 secret); Android landed in
 * Phase 4b (Android Keystore RSA-OAEP-wrapped k256 secret, StrongBox-preferred).
 * Both platforms register the same `HotKey` Capacitor plugin with an identical
 * wire format: ciphertext is "<b64-tag>:<b64-payload>" and the signature is
 * `0x<r||s||v>` (65 bytes hex), so this wrapper is platform-agnostic past the
 * isMobile gate.
 *
 * Native side returns only ciphertext + raw k256 publicKeyHex (the wrap blob
 * embeds its own tag). The commitmentHex needed by MultisigClient.create is
 * derived here via the SDK so the GeneratedHotKey shape matches jsFallback.
 */

import { Buffer } from 'buffer';

import { isAndroid, isIOS } from 'lib/platform';

import { HotKey } from './hotKeyPlugin';
import type { GeneratedHotKey } from './jsFallback';

function assertMobile(): void {
  if (!isIOS() && !isAndroid()) {
    throw new Error('secure-hot-key native plugin invoked outside iOS/Android');
  }
}

export async function generateHotKey(): Promise<GeneratedHotKey> {
  assertMobile();

  const { ciphertext, publicKeyHex } = await HotKey.generateHotKey();
  const commitmentHex = await commitmentFromPublicKeyHex(publicKeyHex);
  return { ciphertext, publicKeyHex, commitmentHex };
}

export async function signHotDigest(ciphertext: string, wordHex: string): Promise<string> {
  assertMobile();

  const { signatureHex } = await HotKey.signWithHotKey({
    ciphertext,
    digestHex: wordHex
  });
  return signatureHex;
}

export async function deleteHotKey(ciphertext: string): Promise<void> {
  assertMobile();

  await HotKey.deleteHotKey({ ciphertext });
}

async function commitmentFromPublicKeyHex(publicKeyHex: string): Promise<string> {
  const { PublicKey } = await import('@miden-sdk/miden-sdk/lazy');
  const raw = Buffer.from(publicKeyHex, 'hex');
  const framed = new Uint8Array(raw.length + 1);
  if (raw.length !== 33) {
    throw new Error(`unexpected public key length ${raw.length} (expected 33)`);
  }
  framed[0] = 1; // ECDSA k256 type prefix expected by PublicKey.deserialize
  framed.set(raw, 1);
  return PublicKey.deserialize(framed).toCommitment().toHex();
}
