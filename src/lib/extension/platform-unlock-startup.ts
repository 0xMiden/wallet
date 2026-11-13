import { isExtension } from 'lib/platform';
import { getPlatformUnlockSupport } from 'lib/platform-auth/capabilities';

let protection: Promise<boolean> | undefined;

export function ensureTrustedPlatformStorage(): Promise<boolean> {
  if (!protection) {
    protection = (async () => {
      if (!isExtension() || process.env.TARGET_BROWSER !== 'chrome') return false;
      try {
        const browser = (await import('webextension-polyfill')).default;
        const setAccessLevel: unknown = Reflect.get(browser.storage.local, 'setAccessLevel');
        if (typeof setAccessLevel !== 'function') return false;
        await setAccessLevel.call(browser.storage.local, { accessLevel: 'TRUSTED_CONTEXTS' });
        return true;
      } catch {
        return false;
      }
    })();
  }
  return protection;
}

export async function getPlatformUnlockAvailability(): Promise<boolean> {
  return (await ensureTrustedPlatformStorage()) && getPlatformUnlockSupport();
}
