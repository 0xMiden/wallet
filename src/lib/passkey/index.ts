import { AppleKeychainPasskeyProvider } from './apple-keychain-provider';
import { PasskeyProvider } from './types';

export { BackupEncryptionMethod } from './types';
export type { PasskeyDerivedKey, PasskeyProvider } from './types';

/**
 * Returns a passkey provider for the current platform, or null if unavailable.
 * Currently only Apple Keychain (WebAuthn + PRF) is supported.
 */
export async function getPasskeyProvider(): Promise<PasskeyProvider | null> {
  const provider = new AppleKeychainPasskeyProvider();
  return (await provider.isAvailable()) ? provider : null;
}
