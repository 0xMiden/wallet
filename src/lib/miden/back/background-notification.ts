import { getMessage } from 'lib/i18n';
import { isExtension } from 'lib/platform';

import { getIntercom } from './defaults';

/**
 * Fire a native background notification. Two mechanisms, in order:
 * `ServiceWorkerRegistration.showNotification` (same system as the Web
 * Notifications API — reliable in Brave), else the `chrome.notifications` API.
 * A no-op when neither is available (mobile/desktop), so callers can invoke it
 * unconditionally. `notificationId` scopes the chrome.notifications entry so a
 * failure alert doesn't replace a received-note alert.
 */
export function showBackgroundNotification(title: string, message: string, notificationId = 'miden-background'): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sw = globalThis as any;
  if (sw.registration?.showNotification) {
    sw.registration.showNotification(title, {
      body: message,
      icon: chrome.runtime.getURL('misc/logo-white-bg-128.png'),
      requireInteraction: true
    });
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chromeNotifications = (globalThis as any).chrome?.notifications;
  if (chromeNotifications) {
    chromeNotifications.create(
      notificationId,
      {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('misc/logo-white-bg-128.png'),
        title,
        message,
        requireInteraction: true
      },
      () => {
        if (chrome.runtime.lastError) {
          console.warn('[background-notification] chrome.notifications error:', chrome.runtime.lastError.message);
        }
      }
    );
  }
}

/**
 * Notify the user that a transaction failed in the background — symmetric with
 * the received-note notification (gap 6). A failed transaction the user isn't
 * watching used to be completely silent: the row went to Failed and nothing told
 * them. This fires only when
 *   - we're on the extension (the received-note path is likewise extension-only;
 *     `showBackgroundNotification` no-ops elsewhere anyway), and
 *   - NO wallet UI is open — an open popup already shows the failure on the
 *     transaction screen, so a notification would be redundant.
 * Best-effort: any error here is swallowed so it can never disturb the caller's
 * own failure handling.
 *
 * UX-REVIEW: reuses the native-notification mechanism the received-note path
 * uses; a future pass may prefer an in-app toast or a badge, and may want
 * per-transaction-type copy. The generic copy here is a first cut.
 */
export function notifyBackgroundTransactionFailed(): void {
  try {
    if (!isExtension()) return;
    if (getIntercom()?.hasClients()) return;
    const title = getMessage('transactionFailedNotificationTitle') || 'Transaction failed';
    const body =
      getMessage('transactionFailedNotificationBody') ||
      "A transaction couldn't be completed. Open the wallet to review.";
    showBackgroundNotification(title, body, 'miden-transaction-failed');
  } catch (err) {
    console.warn('[background-notification] failed to notify a transaction failure:', err);
  }
}
