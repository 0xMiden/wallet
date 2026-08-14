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

import { isAndroid, isIOS } from 'lib/platform';

import { commitmentFromPublicKeyHex } from './commitment';
import { HotKey } from './hotKeyPlugin';
import type { GeneratedHotKey } from './jsFallback';

function assertMobile(): void {
  if (!isIOS() && !isAndroid()) {
    throw new Error('secure-hot-key native plugin invoked outside iOS/Android');
  }
}

export async function generateHotKey(): Promise<GeneratedHotKey> {
  assertMobile();

  const { ciphertext, publicKeyHex, strongBoxError } = await HotKey.generateHotKey();
  if (strongBoxError) {
    // The key works (TEE-backed), but a present StrongBox failed to produce
    // one — surface the report prompt with the raw error without failing the
    // generation. Lazy import mirrors the facade's withHardwareFailureReport.
    try {
      const { reportHotKeyHardwareFailure } = await import('lib/wallet-prompts');
      await reportHotKeyHardwareFailure(`StrongBox failed, key degraded to TEE: ${strongBoxError}`);
    } catch (reportError) {
      console.warn('[secure-hot-key] failed to surface StrongBox degradation prompt:', reportError);
    }
  }
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

export async function revealHotKey(ciphertext: string): Promise<string> {
  assertMobile();

  const { secretKeyHex } = await HotKey.revealHotKey({ ciphertext });
  return secretKeyHex;
}
