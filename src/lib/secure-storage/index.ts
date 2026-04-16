/**
 * Unified Secure Storage API
 *
 * Platform-agnostic interface for hardware-backed encryption.
 * Uses Secure Enclave on macOS/iOS, TPM on Windows, and Keystore on Android.
 *
 * Usage:
 *   const storage = await getSecureStorage();
 *   if (storage) {
 *     await storage.generateKey();
 *     const encrypted = await storage.encrypt(data);
 *     const decrypted = await storage.decrypt(encrypted);
 *   }
 */

import { isDesktop, isMobile } from 'lib/platform';

/**
 * Interface for platform-specific secure storage implementations
 */
export interface SecureStorageAPI {
  /**
   * Check if hardware security is available on this platform
   */
  isAvailable(): Promise<boolean>;

  /**
   * Check if a hardware key has been generated
   */
  hasKey(): Promise<boolean>;

  /**
   * Generate a new hardware-backed key
   * This may prompt for biometric enrollment on some platforms
   */
  generateKey(): Promise<void>;

  /**
   * Encrypt data using the hardware-backed key
   * This will trigger biometric authentication
   *
   * @param data - Data to encrypt as base64 string
   * @returns Encrypted data as base64 string
   */
  encrypt(data: string): Promise<string>;

  /**
   * Decrypt data using the hardware-backed key
   * This will trigger biometric authentication
   *
   * @param encrypted - Encrypted data from encrypt()
   * @returns Decrypted data as base64 string
   */
  decrypt(encrypted: string): Promise<string>;

  /**
   * Delete the hardware-backed key
   * After this, encrypted data cannot be decrypted
   */
  deleteKey(): Promise<void>;
}

/**
 * Desktop secure storage implementation using Tauri + Secure Enclave/TPM
 */
class DesktopSecureStorage implements SecureStorageAPI {
  async isAvailable(): Promise<boolean> {
    const { isHardwareSecurityAvailable } = await import('lib/desktop/secure-storage');
    return isHardwareSecurityAvailable();
  }

  async hasKey(): Promise<boolean> {
    const { hasHardwareKey } = await import('lib/desktop/secure-storage');
    return hasHardwareKey();
  }

  async generateKey(): Promise<void> {
    const { generateHardwareKey } = await import('lib/desktop/secure-storage');
    await generateHardwareKey();
  }

  async encrypt(data: string): Promise<string> {
    const { encryptWithHardwareKey } = await import('lib/desktop/secure-storage');
    return encryptWithHardwareKey(data);
  }

  async decrypt(encrypted: string): Promise<string> {
    const { decryptWithHardwareKey } = await import('lib/desktop/secure-storage');
    return decryptWithHardwareKey(encrypted);
  }

  async deleteKey(): Promise<void> {
    const { deleteHardwareKey } = await import('lib/desktop/secure-storage');
    await deleteHardwareKey();
  }
}

/**
 * Mobile secure storage implementation using Capacitor plugins
 * TODO: Implement in Phase 6
 */
class MobileSecureStorage implements SecureStorageAPI {
  async isAvailable(): Promise<boolean> {
    // TODO: Implement using Capacitor biometric plugin
    return false;
  }

  async hasKey(): Promise<boolean> {
    // TODO: Implement
    return false;
  }

  async generateKey(): Promise<void> {
    // TODO: Implement
    throw new Error('Mobile secure storage not yet implemented');
  }

  async encrypt(_data: string): Promise<string> {
    // TODO: Implement
    throw new Error('Mobile secure storage not yet implemented');
  }

  async decrypt(_encrypted: string): Promise<string> {
    // TODO: Implement
    throw new Error('Mobile secure storage not yet implemented');
  }

  async deleteKey(): Promise<void> {
    // TODO: Implement
    throw new Error('Mobile secure storage not yet implemented');
  }
}

// Singleton instances
let desktopStorage: DesktopSecureStorage | null = null;
let mobileStorage: MobileSecureStorage | null = null;

/**
 * Get the platform-appropriate secure storage instance
 *
 * @returns SecureStorageAPI instance or null if hardware security is not available
 */
export async function getSecureStorage(): Promise<SecureStorageAPI | null> {
  if (isDesktop()) {
    if (!desktopStorage) {
      desktopStorage = new DesktopSecureStorage();
    }
    const available = await desktopStorage.isAvailable();
    return available ? desktopStorage : null;
  }

  if (isMobile()) {
    if (!mobileStorage) {
      mobileStorage = new MobileSecureStorage();
    }
    const available = await mobileStorage.isAvailable();
    return available ? mobileStorage : null;
  }

  // Browser extension - no hardware security available
  return null;
}

/**
 * Check if hardware security is available without getting an instance
 */
export async function isSecureStorageAvailable(): Promise<boolean> {
  if (isDesktop()) {
    try {
      const { isHardwareSecurityAvailable } = await import('lib/desktop/secure-storage');
      return isHardwareSecurityAvailable();
    } catch {
      return false;
    }
  }

  if (isMobile()) {
    // TODO: Implement in Phase 6
    return false;
  }

  return false;
}
