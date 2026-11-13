export const PLATFORM_UNLOCK_STORAGE_KEY = 'vault_key_platform';
export const PLATFORM_CREDENTIALS_STORAGE_KEY = 'platform_credentials_to_signal';
export const PLATFORM_RESET_STORAGE_KEY = 'platform_unlock_reset_request';

export interface PlatformCredentialMetadata {
  credentialId: string;
  prfSalt: string;
  backupEligible: boolean;
}

export interface PlatformUnlockRecord extends PlatformCredentialMetadata {
  version: 1;
  wrappedKey: string;
}

export interface PlatformUnlockState {
  available: boolean;
  hasPassword: boolean;
  credential: PlatformCredentialMetadata | null;
}

export type PlatformUnlockCommand =
  | { action: 'state' }
  | { action: 'begin'; expectedCredentialId: string | null }
  | { action: 'track'; enrollmentId: string; credential: PlatformCredentialMetadata }
  | { action: 'commit'; enrollmentId: string; password: string; prfSecret: string }
  | { action: 'abandon'; enrollmentId: string }
  | { action: 'remove'; expectedCredentialId: string | null }
  | { action: 'unlock'; credentialId: string; prfSecret: string }
  | { action: 'pending-signals' }
  | { action: 'signal-complete'; credentialId: string };
