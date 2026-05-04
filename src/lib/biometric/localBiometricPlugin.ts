/**
 * Custom LocalBiometric plugin for iOS only.
 * This is a local Capacitor plugin that provides biometric authentication
 * using iOS LocalAuthentication framework directly.
 *
 * Also includes hardware security methods for Secure Enclave vault key protection.
 *
 * The Guardian per-account hot-key lives in its own plugin — see
 * `src/lib/secure-hot-key/hotKeyPlugin.ts`.
 */

import { registerPlugin } from '@capacitor/core';

export interface LocalBiometricPlugin {
  isAvailable(): Promise<{
    isAvailable: boolean;
    biometryType: number; // 0 = none, 1 = TouchID, 2 = FaceID, 4 = OpticID
    errorCode?: number;
    errorMessage?: string;
  }>;

  verifyIdentity(options: { reason: string; useFallback?: boolean }): Promise<void>;

  setCredentials(options: { server: string; username: string; password: string }): Promise<void>;

  getCredentials(options: { server: string }): Promise<{ username: string; password: string }>;

  deleteCredentials(options: { server: string }): Promise<void>;

  // Hardware security methods for Secure Enclave vault key protection
  isHardwareSecurityAvailable(): Promise<{ available: boolean }>;

  hasHardwareKey(): Promise<{ exists: boolean }>;

  generateHardwareKey(): Promise<void>;

  encryptWithHardwareKey(options: { data: string }): Promise<{ encrypted: string }>;

  decryptWithHardwareKey(options: { encrypted: string }): Promise<{ decrypted: string }>;

  deleteHardwareKey(): Promise<void>;
}

// Register the plugin - this connects to the native Swift implementation
export const LocalBiometric = registerPlugin<LocalBiometricPlugin>('LocalBiometric');

/**
 * Android Hardware Security plugin interface.
 * Similar to iOS LocalBiometric but using Android Keystore with biometric binding.
 */
export interface HardwareSecurityPlugin {
  isHardwareSecurityAvailable(): Promise<{ available: boolean }>;

  hasHardwareKey(): Promise<{ exists: boolean }>;

  generateHardwareKey(): Promise<void>;

  encryptWithHardwareKey(options: { data: string }): Promise<{ encrypted: string }>;

  decryptWithHardwareKey(options: { encrypted: string }): Promise<{ decrypted: string }>;

  deleteHardwareKey(): Promise<void>;
}

// Register the Android plugin
export const HardwareSecurity = registerPlugin<HardwareSecurityPlugin>('HardwareSecurity');
