import { LocalNotifications } from '@capacitor/local-notifications';
import { InAppBrowser } from '@miden/dapp-browser';

import { hapticSuccess } from 'lib/mobile/haptics';
import { isAndroid, isMobile } from 'lib/platform';
import { useWalletStore } from 'lib/store';
import { navigate } from 'lib/woozie';

// Notification ID for note received - using a fixed ID so new notes replace old notification
const NOTE_RECEIVED_NOTIFICATION_ID = 1001;

// Android notification channel for high-priority notifications (heads-up display)
const NOTE_CHANNEL_ID = 'miden_notes';

// Android importance levels (from NotificationManager)
// 4 = IMPORTANCE_HIGH - shows everywhere, makes noise, peeks (heads-up)
// 5 = IMPORTANCE_MAX - same as HIGH but also uses full-screen intent
const IMPORTANCE_HIGH = 4;

/**
 * Create Android notification channel with high importance for heads-up notifications.
 * Must be called before scheduling notifications on Android.
 */
async function createNotificationChannel(): Promise<void> {
  if (!isAndroid()) return;

  try {
    await LocalNotifications.createChannel({
      id: NOTE_CHANNEL_ID,
      name: 'Notes',
      description: 'Notifications for received notes',
      importance: IMPORTANCE_HIGH, // Required for heads-up display
      visibility: 1, // Public
      vibration: true,
      sound: 'default'
    });
  } catch (error) {
    console.error('[NativeNotifications] Error creating channel:', error);
  }
}

/**
 * Request permission for local notifications.
 * Should be called early in app lifecycle.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (!isMobile()) return false;

  try {
    const permission = await LocalNotifications.checkPermissions();
    if (permission.display === 'granted') {
      return true;
    }

    const request = await LocalNotifications.requestPermissions();
    return request.display === 'granted';
  } catch (error) {
    console.error('[NativeNotifications] Error requesting permission:', error);
    return false;
  }
}

/**
 * Show a native notification for receiving a note.
 * This appears above native webviews and other overlays.
 */
export async function showNoteReceivedNotification(title: string, body: string): Promise<void> {
  if (!isMobile()) return;

  try {
    // Trigger haptic feedback
    hapticSuccess();

    // Cancel any existing note notification first (to reset/replace it)
    await LocalNotifications.cancel({ notifications: [{ id: NOTE_RECEIVED_NOTIFICATION_ID }] });

    await LocalNotifications.schedule({
      notifications: [
        {
          id: NOTE_RECEIVED_NOTIFICATION_ID,
          title,
          body,
          // Show immediately
          schedule: { at: new Date(Date.now() + 100) },
          // Auto-dismiss after 15 seconds
          autoCancel: true,
          // Android: use high-importance channel for heads-up display
          channelId: NOTE_CHANNEL_ID,
          // Extra data for handling tap
          extra: {
            type: 'note_received',
            navigateTo: '/receive?fromNotification=true'
          }
        }
      ]
    });
  } catch (error) {
    console.error('[NativeNotifications] Error showing notification:', error);
  }
}

/**
 * Set up listener for notification taps.
 * When user taps the notification, close any open webview and navigate to the specified route.
 */
export async function setupNotificationTapListener(): Promise<void> {
  if (!isMobile()) return;

  try {
    await LocalNotifications.addListener('localNotificationActionPerformed', async action => {
      console.log('[NativeNotifications] Notification tapped:', action);

      const extra = action.notification.extra;
      if (extra?.navigateTo) {
        // Close InAppBrowser if it's open
        const isDappBrowserOpen = useWalletStore.getState().isDappBrowserOpen;
        if (isDappBrowserOpen) {
          try {
            await InAppBrowser.close();
            // Store state will be updated by the closeEvent listener in Browser.tsx
          } catch (e) {
            console.warn('[NativeNotifications] Error closing InAppBrowser:', e);
          }
        }

        // Small delay to ensure app is ready after closing webview
        setTimeout(() => {
          navigate(extra.navigateTo);
        }, 200);
      }
    });
  } catch (error) {
    console.error('[NativeNotifications] Error setting up tap listener:', error);
  }
}

/**
 * Initialize native notifications - request permission and set up listeners.
 * Call this once when the app starts.
 */
export async function initNativeNotifications(): Promise<void> {
  if (!isMobile()) return;

  await requestNotificationPermission();
  await createNotificationChannel();
  await setupNotificationTapListener();
}
