/**
 * Biometric authentication service for mobile app.
 *
 * This module provides a cross-platform abstraction for biometric authentication
 * (Face ID, Touch ID, fingerprint), plus hardware-backed encryption of the vault
 * decryption key using the device's secure keystore (iOS Secure Enclave / Android
 * Keystore).
 */

import { isMobile, isIOS, isAndroid } from 'lib/platform';

import { LocalBiometric, LocalBiometricPlugin, HardwareSecurity, HardwareSecurityPlugin } from './localBiometricPlugin';

// Lazy-load the plugin to avoid issues in non-mobile contexts
let _nativeBiometricModule: typeof import('capacitor-native-biometric') | null = null;
let _biometricChecked = false;

// Get the appropriate biometric plugin based on platform
// iOS: Use our custom LocalBiometric plugin (Swift)
// Android: Use capacitor-native-biometric package
function getBiometricPlugin():
  | LocalBiometricPlugin
  | typeof import('capacitor-native-biometric').NativeBiometric
  | null {
  if (!isMobile() || typeof window === 'undefined') {
    return null;
  }

  // iOS: Use custom LocalBiometric plugin
  if (isIOS()) {
    console.log('[Biometric] Using LocalBiometric plugin for iOS');
    return LocalBiometric;
  }

  // Android: Use capacitor-native-biometric
  return getNativeBiometricModule()?.NativeBiometric ?? null;
}

function getNativeBiometricModule(): typeof import('capacitor-native-biometric') | null {
  if (!_biometricChecked) {
    _biometricChecked = true;
    console.log('[Biometric] getNativeBiometricModule called, isMobile:', isMobile());
    if (isMobile() && typeof window !== 'undefined') {
      try {
        // Use require instead of dynamic import to avoid issues in Chrome extension
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        _nativeBiometricModule = require('capacitor-native-biometric');
        console.log('[Biometric] NativeBiometric module loaded successfully');
      } catch (err) {
        console.error('[Biometric] Failed to load NativeBiometric:', err);
        _nativeBiometricModule = null;
      }
    }
  }
  return _nativeBiometricModule;
}

export interface BiometricAvailability {
  isAvailable: boolean;
  biometryType: 'face' | 'fingerprint' | 'iris' | 'multiple' | 'none';
  errorCode?: number;
  errorMessage?: string;
}

/**
 * Check if biometric authentication is available on the device.
 * Returns information about the type of biometric hardware available.
 */
export async function checkBiometricAvailability(): Promise<BiometricAvailability> {
  console.log('[Biometric] checkBiometricAvailability called');
  const plugin = getBiometricPlugin();

  if (!plugin) {
    console.log('[Biometric] Biometric plugin is null');
    return {
      isAvailable: false,
      biometryType: 'none',
      errorMessage: 'Biometric plugin not available'
    };
  }

  try {
    console.log('[Biometric] Calling isAvailable()');
    const result = await plugin.isAvailable();
    console.log('[Biometric] isAvailable result:', JSON.stringify(result));
    let biometryType: BiometricAvailability['biometryType'] = 'none';

    // Android reports capacitor-native-biometric's BiometryType (FINGERPRINT 3, FACE_AUTHENTICATION 4,
    // IRIS_AUTHENTICATION 5, MULTIPLE 6); iOS reports LocalBiometric's (Touch ID 1, Face ID 2, and
    // Optic ID 4, which reads as 'face').
    switch (result.biometryType) {
      case 1:
      case 3:
        biometryType = 'fingerprint';
        break;
      case 2:
      case 4:
        biometryType = 'face';
        break;
      case 5:
        biometryType = 'iris';
        break;
      case 6:
        biometryType = 'multiple';
        break;
      default:
        biometryType = 'none';
    }

    return {
      isAvailable: result.isAvailable,
      biometryType,
      errorCode: result.errorCode
    };
  } catch (error: any) {
    console.error('[Biometric] Error in isAvailable:', error);
    return {
      isAvailable: false,
      biometryType: 'none',
      errorMessage: error.message || 'Failed to check biometric availability'
    };
  }
}

/** Why biometric setup cannot go ahead; see {@link checkBiometricSetup}. */
export type BiometricUnavailableReason =
  | 'none-enrolled'
  | 'strong-not-enrolled'
  | 'no-strong-biometric'
  | 'hardware-unavailable'
  | 'security-update-required'
  | 'passcode-not-set'
  | 'locked-out'
  | 'unknown';

export interface BiometricSetup {
  available: boolean;
  /** Null exactly when `available` is true. */
  reason: BiometricUnavailableReason | null;
  /** True in an Android work profile, whose biometric enrollments are its own. */
  managedProfile: boolean;
}

/**
 * Map a raw `BiometricManager.canAuthenticate(BIOMETRIC_STRONG)` result (androidx.biometric 1.1.0),
 * plus the BIOMETRIC_WEAK result for the NONE_ENROLLED case, to why setup is blocked, or null for
 * BIOMETRIC_SUCCESS. Asked for STRONG, NO_HARDWARE (12) also covers a device whose only biometric
 * is class 2 but which has nothing enrolled either way (`weakCode` not 0): there `weakCode` can't
 * tell the two apart, so NO_HARDWARE stays 'no-strong-biometric' regardless.
 */
export function reasonForAndroidStatus(code: number, weakCode?: number): BiometricUnavailableReason | null {
  switch (code) {
    case 0: // BIOMETRIC_SUCCESS
      return null;
    case 11: // BIOMETRIC_ERROR_NONE_ENROLLED
      // weakCode 0 (BIOMETRIC_SUCCESS for WEAK) means a class-2 biometric IS enrolled, just not
      // a strong one - fixable by enrolling a stronger biometric, unlike having none at all.
      return weakCode === 0 ? 'strong-not-enrolled' : 'none-enrolled';
    case 12: // BIOMETRIC_ERROR_NO_HARDWARE
      return 'no-strong-biometric';
    case 1: // BIOMETRIC_ERROR_HW_UNAVAILABLE
      return 'hardware-unavailable';
    case 15: // BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED
      return 'security-update-required';
    default:
      return 'unknown';
  }
}

/**
 * Map a BiometricAuthError code (capacitor-native-biometric's numbering, which the iOS
 * LocalBiometric plugin reports too) to why setup is blocked.
 */
export function reasonForPluginError(code: number | undefined): BiometricUnavailableReason {
  switch (code) {
    case 3: // BIOMETRICS_NOT_ENROLLED
      return 'none-enrolled';
    case 1: // BIOMETRICS_UNAVAILABLE
      return 'hardware-unavailable';
    case 2: // USER_LOCKOUT
    case 4: // USER_TEMPORARY_LOCKOUT
      return 'locked-out';
    case 14: // PASSCODE_NOT_SET
      return 'passcode-not-set';
    default:
      return 'unknown';
  }
}

/**
 * Whether biometric unlock can be set up, and if not, why. On Android it asks for a
 * BIOMETRIC_STRONG biometric enrolled for the current user, the class the vault key accepts;
 * on iOS it reads LocalBiometric's availability. Never rejects: any failure reads as 'unknown'.
 */
export async function checkBiometricSetup(): Promise<BiometricSetup> {
  try {
    if (isAndroid()) {
      const { code, weakCode, managedProfile } = await HardwareSecurity.biometricStatus();
      const reason = reasonForAndroidStatus(code, weakCode);
      return { available: reason === null, reason, managedProfile };
    }
    if (isIOS()) {
      const { isAvailable, errorCode } = await LocalBiometric.isAvailable();
      return isAvailable
        ? { available: true, reason: null, managedProfile: false }
        : { available: false, reason: reasonForPluginError(errorCode), managedProfile: false };
    }
  } catch (error) {
    console.error('[Biometric] checkBiometricSetup error:', error);
  }
  return { available: false, reason: 'unknown', managedProfile: false };
}

/**
 * Open the system screen that enrolls a strong biometric (Android only). A no-op off
 * Android or when the call fails. Never rejects.
 */
export async function openBiometricSettings(): Promise<void> {
  try {
    if (!isAndroid()) return;
    await HardwareSecurity.openBiometricSettings();
  } catch (error) {
    console.error('[Biometric] openBiometricSettings error:', error);
  }
}

/**
 * Prompt the user for biometric authentication.
 * Returns true if authentication was successful, false otherwise.
 *
 * @param reason - The reason to display to the user (e.g., "Unlock your wallet")
 */
export async function authenticate(reason: string): Promise<boolean> {
  const plugin = getBiometricPlugin();

  if (!plugin) {
    return false;
  }

  try {
    // iOS LocalBiometric has simpler API, Android capacitor-native-biometric has more options
    if (isIOS()) {
      await plugin.verifyIdentity({
        reason,
        useFallback: true
      });
    } else {
      await (plugin as typeof import('capacitor-native-biometric').NativeBiometric).verifyIdentity({
        reason,
        title: 'Bread',
        subtitle: reason,
        description: '',
        useFallback: true,
        fallbackTitle: 'Use Password'
      });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Ask the device owner to confirm a send, swap, earn deposit or dApp transaction
 * when this wallet unlocks with biometrics (the vault holds its hardware
 * protector). A password or passcode wallet, and any non-mobile platform, is not
 * prompted.
 *
 * The prompt allows the device passcode as a fallback, so a biometry lockout
 * still prompts rather than skipping the check. A probe that rejects propagates:
 * the caller shows its error and the action does not proceed.
 *
 * @param reason - Prompt text shown to the user (e.g. "Confirm your send").
 * @param probe - Whether the vault holds its hardware protector. Callers pass
 *   `probeHardwareProtector` (`lib/miden/back/protector-probe`) by reference, which answers from the
 *   hardware key read and rejects only when both protector reads fail. It is a parameter rather than
 *   an import because the vault imports this module.
 */
export async function confirmSensitiveAction(reason: string, probe: () => Promise<boolean>): Promise<boolean> {
  if (!isMobile()) return true;
  if (!(await probe())) return true;
  return authenticate(reason);
}

export const biometricService = {
  checkBiometricAvailability,
  authenticate
};

export default biometricService;

// =============================================================================
// Hardware Security API for Vault Key Protection
// =============================================================================

/**
 * Get the hardware security plugin based on platform.
 * iOS: Uses LocalBiometric plugin (Secure Enclave)
 * Android: Uses HardwareSecurity plugin (Android Keystore)
 */
function getHardwareSecurityPlugin(): LocalBiometricPlugin | HardwareSecurityPlugin | null {
  if (!isMobile() || typeof window === 'undefined') {
    return null;
  }

  if (isIOS()) {
    return LocalBiometric;
  }

  if (isAndroid()) {
    return HardwareSecurity;
  }

  return null;
}

/**
 * Check if hardware-backed security is available for vault key protection.
 * Returns true on real devices with Secure Enclave (iOS) or TEE/StrongBox (Android).
 * Returns false on simulators/emulators.
 */
export async function isHardwareSecurityAvailable(): Promise<boolean> {
  console.log('[HardwareSecurity] isHardwareSecurityAvailable called');
  const plugin = getHardwareSecurityPlugin();

  if (!plugin) {
    console.log('[HardwareSecurity] Plugin not available');
    return false;
  }

  try {
    const result = await plugin.isHardwareSecurityAvailable();
    console.log('[HardwareSecurity] isHardwareSecurityAvailable result:', result.available);
    return result.available;
  } catch (error) {
    console.error('[HardwareSecurity] isHardwareSecurityAvailable error:', error);
    return false;
  }
}

/**
 * Check if a hardware key already exists.
 */
export async function hasHardwareKey(): Promise<boolean> {
  console.log('[HardwareSecurity] hasHardwareKey called');
  const plugin = getHardwareSecurityPlugin();

  if (!plugin) {
    return false;
  }

  try {
    const result = await plugin.hasHardwareKey();
    console.log('[HardwareSecurity] hasHardwareKey result:', result.exists);
    return result.exists;
  } catch (error) {
    console.error('[HardwareSecurity] hasHardwareKey error:', error);
    return false;
  }
}

/**
 * Generate a new hardware-backed key.
 * On iOS: Creates EC P-256 key in Secure Enclave
 * On Android: Creates AES-256 key in Android Keystore with biometric binding
 */
export async function generateHardwareKey(): Promise<void> {
  console.log('[HardwareSecurity] generateHardwareKey called');
  const plugin = getHardwareSecurityPlugin();

  if (!plugin) {
    throw new Error('Hardware security not available');
  }

  await plugin.generateHardwareKey();
  console.log('[HardwareSecurity] Hardware key generated');
}

/**
 * Encrypt data using the hardware-backed key.
 * May trigger biometric authentication.
 *
 * @param data - The data to encrypt (UTF-8 string)
 * @returns Base64-encoded encrypted data
 */
export async function encryptWithHardwareKey(data: string): Promise<string> {
  console.log('[HardwareSecurity] encryptWithHardwareKey called');
  const plugin = getHardwareSecurityPlugin();

  if (!plugin) {
    throw new Error('Hardware security not available');
  }

  const result = await plugin.encryptWithHardwareKey({ data });
  console.log('[HardwareSecurity] Encryption successful');
  return result.encrypted;
}

/**
 * Decrypt data using the hardware-backed key.
 * This will trigger biometric authentication.
 *
 * @param encrypted - Base64-encoded encrypted data
 * @returns The decrypted data as a string
 */
export async function decryptWithHardwareKey(encrypted: string): Promise<string> {
  console.log('[HardwareSecurity] decryptWithHardwareKey called');
  const plugin = getHardwareSecurityPlugin();

  if (!plugin) {
    throw new Error('Hardware security not available');
  }

  const result = await plugin.decryptWithHardwareKey({ encrypted });
  console.log('[HardwareSecurity] Decryption successful');
  return result.decrypted;
}

/**
 * Delete the hardware-backed key.
 * Call this when resetting the wallet or disabling biometric unlock.
 */
export async function deleteHardwareKey(): Promise<void> {
  console.log('[HardwareSecurity] deleteHardwareKey called');
  const plugin = getHardwareSecurityPlugin();

  if (!plugin) {
    return;
  }

  try {
    await plugin.deleteHardwareKey();
    console.log('[HardwareSecurity] Hardware key deleted');
  } catch (error) {
    console.error('[HardwareSecurity] deleteHardwareKey error:', error);
  }
}

// Export hardware security functions
export const hardwareSecurityService = {
  isHardwareSecurityAvailable,
  hasHardwareKey,
  generateHardwareKey,
  encryptWithHardwareKey,
  decryptWithHardwareKey,
  deleteHardwareKey
};
