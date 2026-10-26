import { ACTIVITY_PENDING_PATH } from 'app/pages/activity-paths';
import { isExtension } from 'lib/platform';

/**
 * Show a desktop notification from the extension.
 *
 * Uses the Web Notifications API (works reliably across Chromium browsers
 * including Brave), with chrome.notifications as fallback.
 */
export async function showExtensionNotification(title: string, message: string): Promise<void> {
  if (!isExtension()) return;

  try {
    if (typeof Notification !== 'undefined') {
      const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();

      if (permission === 'granted') {
        const notif = new Notification(title, {
          body: message,
          icon: chrome.runtime.getURL('misc/logo-white-bg-128.png'),
          requireInteraction: true
        });

        notif.onclick = () => {
          // Match the mobile handler's incoming-notes claim target (#467).
          chrome.tabs.create({ url: chrome.runtime.getURL(`fullpage.html#${ACTIVITY_PENDING_PATH}`) });
          notif.close();
        };
        return;
      }
    }
  } catch {
    // An exposed Web API may be unusable while the Chrome fallback is available.
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chromeNotifications = (globalThis as any).chrome?.notifications;
    if (!chromeNotifications) return;

    chromeNotifications.create(
      'miden-note-received',
      {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('misc/logo-white-bg-128.png'),
        title,
        message,
        requireInteraction: true
      },
      () => {
        if (chrome.runtime.lastError) {
          console.error('[ExtensionNotifications] Error:', chrome.runtime.lastError.message);
        }
      }
    );
  } catch {
    // Notification failures must not interrupt incoming-note handling.
  }
}
