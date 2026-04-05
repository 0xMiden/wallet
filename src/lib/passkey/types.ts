export enum BackupEncryptionMethod {
  Password = 0x01,
  Passkey = 0x02,
}

/** Result of WebAuthn PRF key derivation */
export interface PasskeyDerivedKey {
  /** Raw 32-byte symmetric key derived from PRF output via HKDF */
  keyMaterial: Uint8Array;
  /** WebAuthn credential ID (stored in backup header for restore) */
  credentialId: Uint8Array;
  /** The salt used for HKDF derivation (stored in backup header) */
  prfSalt: Uint8Array;
}

/**
 * Abstract passkey provider for backup encryption key derivation.
 * Mirrors the CloudProvider pattern. Runs in the FRONTEND context only
 * (WebAuthn APIs are not available in service workers).
 */
export interface PasskeyProvider {
  /** Provider identifier (e.g. 'apple-keychain') */
  readonly providerId: string;
  /** Display name for UI */
  readonly displayName: string;

  /** Check if this provider is available on the current platform */
  isAvailable(): Promise<boolean>;

  /**
   * Create a new passkey and derive encryption key material.
   * Calls navigator.credentials.create() with PRF extension.
   * @param appSalt - Random 32-byte salt for HKDF (stored in backup)
   */
  register(appSalt: Uint8Array): Promise<PasskeyDerivedKey>;

  /**
   * Use an existing passkey to re-derive encryption key material.
   * Calls navigator.credentials.get() with PRF extension.
   * @param credentialId - The credential ID from a previous registration
   * @param prfSalt - The salt that was used during registration
   */
  authenticate(credentialId: Uint8Array, prfSalt: Uint8Array): Promise<PasskeyDerivedKey>;
}
