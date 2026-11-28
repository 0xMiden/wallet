import { LocalNotifications } from '@capacitor/local-notifications';

import { hapticSuccess } from 'lib/mobile/haptics';
import { isExtension, isMobile } from 'lib/platform';

/** The native notification id of the arrival notice. A new notice replaces the one before it. */
export const DEPOSIT_ARRIVED_NOTIFICATION_ID = 1002;

/** The `extra.type` of the native notice. The tap listener of `lib/mobile/native-notifications` opens `navigateTo`. */
export const DEPOSIT_ARRIVED_NOTIFICATION_TYPE = 'deposit_arrived';

/** The id of the `chrome.notifications` fallback. It does not replace a received-note notice. */
const EXTENSION_FALLBACK_ID = 'miden-deposit-arrived';

/**
 * The Android channel of the received-note notice (`NOTE_CHANNEL_ID` in `lib/mobile/native-notifications`), which
 * `initNativeNotifications` creates. The arrival notice uses the same heads-up channel.
 */
const NATIVE_CHANNEL_ID = 'miden_notes';

const NOTICE_ICON_PATH = 'misc/logo-white-bg-128.png';

export interface DepositArrivalNotice {
  title: string;
  body: string;
  /** The wallet route that a tap opens. */
  path: string;
  /** One notice for each tag: the browser replaces a notice with the same tag. */
  tag: string;
}

/**
 * Shows the arrival notice of a deposit through the platform's notification path, as the received-note notice does.
 * Mobile: a native notification, only while the system permission is granted; a tap opens `path`. Extension: a Web
 * notification, only while its permission is granted; a click opens `path` in a wallet tab. Without the Web API, the
 * `chrome.notifications` fallback shows it with no click action. Other platforms show nothing. It never throws.
 */
export async function showDepositArrivalNotice(notice: DepositArrivalNotice): Promise<void> {
  try {
    if (isMobile()) {
      await showNativeNotice(notice);
      return;
    }
    if (isExtension()) showExtensionNotice(notice);
  } catch (error) {
    console.warn('[deposit-flow] the arrival notice failed', error);
  }
}

async function showNativeNotice({ title, body, path }: DepositArrivalNotice): Promise<void> {
  const permission = await LocalNotifications.checkPermissions();
  if (permission.display !== 'granted') return;
  hapticSuccess();
  await LocalNotifications.cancel({ notifications: [{ id: DEPOSIT_ARRIVED_NOTIFICATION_ID }] });
  await LocalNotifications.schedule({
    notifications: [
      {
        id: DEPOSIT_ARRIVED_NOTIFICATION_ID,
        title,
        body,
        schedule: { at: new Date(Date.now() + 100) },
        autoCancel: true,
        channelId: NATIVE_CHANNEL_ID,
        extra: { type: DEPOSIT_ARRIVED_NOTIFICATION_TYPE, navigateTo: path }
      }
    ]
  });
}

function showExtensionNotice({ title, body, path, tag }: DepositArrivalNotice): void {
  const icon = chrome.runtime.getURL(NOTICE_ICON_PATH);
  if (typeof Notification !== 'undefined') {
    // The user or the browser turned notifications off: show nothing.
    if (Notification.permission !== 'granted') return;
    const notification = new Notification(title, { body, icon, tag, requireInteraction: true });
    notification.onclick = () => {
      chrome.tabs.create({ url: chrome.runtime.getURL(`fullpage.html#${path}`) });
      notification.close();
    };
    return;
  }
  chrome.notifications.create(
    EXTENSION_FALLBACK_ID,
    { type: 'basic', iconUrl: icon, title, message: body, requireInteraction: true },
    () => {
      if (chrome.runtime.lastError) {
        console.warn('[deposit-flow] chrome.notifications error:', chrome.runtime.lastError.message);
      }
    }
  );
}
