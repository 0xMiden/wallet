/**
 * Biometric authentication service for mobile app.
 *
 * This module provides a cross-platform abstraction for biometric authentication
 * (Face ID, Touch ID, fingerprint) and secure credential storage using the
 * device's hardware-backed keystore (iOS Secure Enclave / Android Keystore).
 *
 * The credentials are encrypted with a key that requires biometric authentication
 * to access, providing hardware-level security for the vault decryption key.
 */

import { isMobile, isIOS, isAndroid } from 'lib/platform';

import { LocalBiometric, LocalBiometricPlugin, HardwareSecurity, HardwareSecurityPlugin } from './localBiometricPlugin';

// Storage key for biometric-protected vault credential
const BIOMETRIC_CREDENTIAL_KEY = 'vault_biometric_key';
// Storage key for biometric enabled preference
const BIOMETRIC_ENABLED_KEY = 'biometric_enabled';

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

    // BiometryType enum:
    // 1 = TOUCH_ID/FINGERPRINT, 2 = FACE_ID, 3 = IRIS, 4 = MULTIPLE/OPTIC_ID
    switch (result.biometryType) {
      case 1:
        biometryType = 'fingerprint';
        break;
      case 2:
        biometryType = 'face';
        break;
      case 3:
        biometryType = 'iris';
        break;
      case 4:
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
 * Store a credential (e.g., vault decryption key) in the secure keystore.
 * The credential is protected by biometric authentication - it can only be
 * retrieved after successful biometric verification.
 *
 * @param value - The credential value to store (typically the password or derived key)
 */
export async function storeCredential(value: string): Promise<void> {
  const plugin = getBiometricPlugin();

  if (!plugin) {
    throw new Error('Biometric plugin not available');
  }

  await plugin.setCredentials({
    username: BIOMETRIC_CREDENTIAL_KEY,
    password: value,
    server: 'miden.wallet.biometric'
  });
}

/**
 * Retrieve a stored credential from the secure keystore.
 * This will trigger biometric authentication before returning the credential.
 *
 * @returns The stored credential value, or null if not found or authentication failed
 */
export async function getCredential(): Promise<string | null> {
  const plugin = getBiometricPlugin();

  if (!plugin) {
    return null;
  }

  try {
    const credentials = await plugin.getCredentials({
      server: 'miden.wallet.biometric'
    });
    return credentials.password;
  } catch {
    return null;
  }
}

/**
 * Delete the stored credential from the secure keystore.
 * Call this when the user disables biometric unlock or resets the wallet.
 */
export async function deleteCredential(): Promise<void> {
  const plugin = getBiometricPlugin();

  if (!plugin) {
    return;
  }

  try {
    await plugin.deleteCredentials({
      server: 'miden.wallet.biometric'
    });
  } catch {
    // Ignore errors when deleting (credential may not exist)
  }
}

/**
 * Check if biometric unlock is enabled for this wallet.
 */
export async function isBiometricEnabled(): Promise<boolean> {
  if (!isMobile()) {
    return false;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Preferences } = require('@capacitor/preferences');
    const result = await Preferences.get({ key: BIOMETRIC_ENABLED_KEY });
    console.log('[Biometric] isBiometricEnabled result:', JSON.stringify(result), 'value:', result.value);
    return result.value === 'true';
  } catch (error) {
    console.error('[Biometric] isBiometricEnabled error:', error);
    return false;
  }
}

/**
 * Enable or disable biometric unlock.
 * When enabling, make sure to call storeCredential first with the vault password.
 *
 * @param enabled - Whether biometric unlock should be enabled
 */
export async function setBiometricEnabled(enabled: boolean): Promise<void> {
  console.log('[Biometric] setBiometricEnabled called with:', enabled);
  if (!isMobile()) {
    console.log('[Biometric] setBiometricEnabled: not mobile, returning');
    return;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Preferences } = require('@capacitor/preferences');
    const valueToSet = enabled ? 'true' : 'false';
    console.log('[Biometric] setBiometricEnabled: about to set key:', BIOMETRIC_ENABLED_KEY, 'value:', valueToSet);
    await Preferences.set({
      key: BIOMETRIC_ENABLED_KEY,
      value: valueToSet
    });
    console.log('[Biometric] setBiometricEnabled: set completed');

    // Verify the preference was actually written
    const verification = await Preferences.get({ key: BIOMETRIC_ENABLED_KEY });
    console.log('[Biometric] setBiometricEnabled: verification read:', JSON.stringify(verification));

    if (verification.value !== valueToSet) {
      console.error(
        '[Biometric] setBiometricEnabled: VERIFICATION FAILED! Expected:',
        valueToSet,
        'Got:',
        verification.value
      );
    } else {
      console.log('[Biometric] setBiometricEnabled: preference verified successfully');
    }

    // If disabling, also delete the stored credential
    if (!enabled) {
      await deleteCredential();
    }
  } catch (error) {
    console.error('[Biometric] setBiometricEnabled error:', error);
  }
}

/**
 * Attempt to unlock the wallet using biometric authentication.
 * This combines authentication and credential retrieval in a single flow.
 *
 * @param reason - The reason to display to the user
 * @returns The stored password if successful, null otherwise
 */
export async function unlockWithBiometric(reason: string): Promise<string | null> {
  const plugin = getBiometricPlugin();

  if (!plugin) {
    return null;
  }

  try {
    // First verify identity
    if (isIOS()) {
      await plugin.verifyIdentity({
        reason,
        useFallback: false
      });
    } else {
      await (plugin as typeof import('capacitor-native-biometric').NativeBiometric).verifyIdentity({
        reason,
        title: 'Bread',
        subtitle: reason,
        description: '',
        useFallback: false
      });
    }

    // Then get the stored credential
    const credentials = await plugin.getCredentials({
      server: 'miden.wallet.biometric'
    });

    return credentials.password;
  } catch {
    return null;
  }
}

/**
 * Set up biometric authentication for a wallet.
 * This should be called after the user creates or imports a wallet,
 * storing the password for future biometric unlocks.
 *
 * @param password - The wallet password to store for biometric unlock
 * @returns true if setup was successful, false otherwise
 */
export async function setupBiometric(password: string): Promise<boolean> {
  try {
    // Check availability first
    const availability = await checkBiometricAvailability();
    if (!availability.isAvailable) {
      return false;
    }

    // Authenticate to confirm user identity
    const authenticated = await authenticate('Set up biometric unlock');
    if (!authenticated) {
      return false;
    }

    // Store the credential
    await storeCredential(password);

    // Enable biometric unlock
    await setBiometricEnabled(true);

    return true;
  } catch (error) {
    console.error('Failed to setup biometric:', error);
    return false;
  }
}

export const biometricService = {
  checkBiometricAvailability,
  authenticate,
  storeCredential,
  getCredential,
  deleteCredential,
  isBiometricEnabled,
  setBiometricEnabled,
  unlockWithBiometric,
  setupBiometric
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
