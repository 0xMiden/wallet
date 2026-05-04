/**
 * Capacitor handle for the per-account Guardian "hot" signing key.
 * iOS implementation lives in ios/App/App/HotKeyPlugin.swift; Android lands
 * in Phase 4b and will register the same `HotKey` jsName so this interface
 * stays platform-shared.
 *
 * Native side ECIES-wraps a fresh secp256k1 secret under a per-account
 * Secure Enclave / StrongBox P-256 key; the resulting ciphertext embeds the
 * key tag so signWithHotKey can look it up without an extra arg.
 */

import { registerPlugin } from '@capacitor/core';

export interface HotKeyPlugin {
  generateHotKey(): Promise<{ ciphertext: string; publicKeyHex: string }>;

  signWithHotKey(options: { ciphertext: string; digestHex: string }): Promise<{ signatureHex: string }>;

  deleteHotKey(options: { ciphertext: string }): Promise<void>;
}

export const HotKey = registerPlugin<HotKeyPlugin>('HotKey');
