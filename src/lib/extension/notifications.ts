import { isExtension } from 'lib/platform';

/**
 * Show a desktop notification from the extension.
 *
 * Uses the Web Notifications API (works reliably across Chromium browsers
 * including Brave), with chrome.notifications as fallback.
 */
export async function showExtensionNotification(title: string, message: string): Promise<void> {
  if (!isExtension()) return;

  // Try Web Notifications API first — more reliable across browsers (Brave, etc.)
  if (typeof Notification !== 'undefined') {
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();

    if (permission === 'granted') {
      const notif = new Notification(title, {
        body: message,
        icon: chrome.runtime.getURL('misc/logo-white-bg-128.png')
      });

      notif.onclick = () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('fullpage.html#/receive') });
        notif.close();
      };
      return;
    }
  }

  // Fallback to chrome.notifications API
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chromeNotifications = (globalThis as any).chrome?.notifications;
  if (!chromeNotifications) return;

  chromeNotifications.create(
    'miden-note-received',
    {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('misc/logo-white-bg-128.png'),
      title,
      message
    },
    () => {
      if (chrome.runtime.lastError) {
        console.error('[ExtensionNotifications] Error:', chrome.runtime.lastError.message);
      }
    }
  );
}
