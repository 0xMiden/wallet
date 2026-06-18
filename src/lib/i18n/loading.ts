import i18n from 'i18next';

import { isExtension } from 'lib/platform';

import { init } from './core';
import { saveLocale } from './saving';

export const REFRESH_MSGTYPE = 'ALEO_I18N_REFRESH';

// Normalize locale codes: en_GB -> en-GB for i18next
function normalizeLocale(locale: string): string {
  return locale.replace('_', '-');
}

// Set up extension message listener for cross-tab locale sync (extension only)
if (isExtension()) {
  import('webextension-polyfill').then(browserModule => {
    // Resolve via .default to handle CJS-style default export (matches the
    // pattern used in storage-adapter.ts and intercom/client.ts).
    const runtime = (browserModule.default ?? browserModule).runtime;
    runtime.onMessage.addListener((msg: unknown) => {
      if (typeof msg === 'object' && msg !== null && (msg as { type?: string }).type === REFRESH_MSGTYPE) {
        const locale = (msg as { locale?: string }).locale;
        if (locale) {
          i18n.changeLanguage(normalizeLocale(locale));
        }
      }
    });
  });
}

export function onInited(callback: () => void) {
  init().then(callback);
}

export async function updateLocale(locale: string) {
  saveLocale(locale);
  await i18n.changeLanguage(normalizeLocale(locale));
  notifyOthers(locale);
}

function notifyOthers(locale: string) {
  // Only notify other tabs/windows on extension (uses webextension-polyfill)
  if (!isExtension()) {
    return;
  }

  import('webextension-polyfill').then(browserModule => {
    browserModule.runtime.sendMessage({ type: REFRESH_MSGTYPE, locale }).catch(() => {
      // Ignore errors when no other contexts are listening
    });
  });
}
