import { isExtension } from 'lib/platform';
import { getPlatformUnlockSupport } from 'lib/platform-auth/capabilities';

let protection: Promise<boolean> | undefined;
let startupCheck: Promise<void> | undefined;

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

export function ensurePlatformUnlockStartup(): Promise<void> {
  if (!startupCheck) {
    startupCheck = (async () => {
      await ensureTrustedPlatformStorage();
      if (isExtension()) {
        const { resumeExtensionReset } = await import('lib/miden/platform-reset');
        await resumeExtensionReset();
      }
    })();
    const current = startupCheck;
    void current.finally(() => { if (startupCheck === current) startupCheck = undefined; }).catch(() => undefined);
  }
  return startupCheck;
}

export async function getPlatformUnlockAvailability(): Promise<boolean> {
  return (await ensureTrustedPlatformStorage()) && getPlatformUnlockSupport();
}
