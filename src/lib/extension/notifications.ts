import browser from 'webextension-polyfill';

import { isExtension } from 'lib/platform';

/**
 * Show a Chrome desktop notification.
 * Uses a fixed ID so new notes replace the previous notification.
 */
export async function showExtensionNotification(title: string, message: string): Promise<void> {
  if (!isExtension()) return;

  try {
    await browser.notifications.create('miden-note-received', {
      type: 'basic',
      iconUrl: browser.runtime.getURL('misc/logo-white-bg-128.png'),
      title,
      message
    });
  } catch (error) {
    console.error('[ExtensionNotifications] Error showing notification:', error);
  }
}
