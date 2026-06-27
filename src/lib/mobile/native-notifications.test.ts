import { LocalNotifications } from '@capacitor/local-notifications';

import { InAppBrowser } from '@miden/dapp-browser';
import { hapticSuccess } from 'lib/mobile/haptics';
import { isMobile, isAndroid } from 'lib/platform';
import { useWalletStore } from 'lib/store';
import { navigate } from 'lib/woozie';

import {
  requestNotificationPermission,
  showNoteReceivedNotification,
  setupNotificationTapListener,
  initNativeNotifications
} from './native-notifications';

jest.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    checkPermissions: jest.fn(),
    requestPermissions: jest.fn(),
    createChannel: jest.fn(),
    cancel: jest.fn(),
    schedule: jest.fn(),
    addListener: jest.fn()
  }
}));

jest.mock('@miden/dapp-browser', () => ({
  InAppBrowser: {
    // PR-4 chunk 9: native-notifications now closes ALL active dApp
    // instances on notification tap, not just the legacy default slot.
    close: jest.fn(),
    closeAll: jest.fn()
  }
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticSuccess: jest.fn()
}));

jest.mock('lib/platform', () => ({
  isMobile: jest.fn(),
  isAndroid: jest.fn()
}));

jest.mock('lib/store', () => ({
  useWalletStore: {
    getState: jest.fn(() => ({ isDappBrowserOpen: false }))
  }
}));

jest.mock('lib/woozie', () => ({
  navigate: jest.fn()
}));

const mockIsMobile = isMobile as jest.MockedFunction<typeof isMobile>;
const mockIsAndroid = isAndroid as jest.MockedFunction<typeof isAndroid>;

describe('native-notifications', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsMobile.mockReturnValue(true);
    mockIsAndroid.mockReturnValue(true);
  });

  describe('requestNotificationPermission', () => {
    it('returns false when not on mobile', async () => {
      mockIsMobile.mockReturnValue(false);

      const result = await requestNotificationPermission();

      expect(result).toBe(false);
      expect(LocalNotifications.checkPermissions).not.toHaveBeenCalled();
    });

    it('returns true when permission already granted', async () => {
      (LocalNotifications.checkPermissions as jest.Mock).mockResolvedValue({ display: 'granted' });

      const result = await requestNotificationPermission();

      expect(result).toBe(true);
      expect(LocalNotifications.requestPermissions).not.toHaveBeenCalled();
    });

    it('requests permission when not yet granted', async () => {
      (LocalNotifications.checkPermissions as jest.Mock).mockResolvedValue({ display: 'prompt' });
      (LocalNotifications.requestPermissions as jest.Mock).mockResolvedValue({ display: 'granted' });

      const result = await requestNotificationPermission();

      expect(result).toBe(true);
      expect(LocalNotifications.requestPermissions).toHaveBeenCalled();
    });

    it('returns false when permission denied', async () => {
      (LocalNotifications.checkPermissions as jest.Mock).mockResolvedValue({ display: 'prompt' });
      (LocalNotifications.requestPermissions as jest.Mock).mockResolvedValue({ display: 'denied' });

      const result = await requestNotificationPermission();

      expect(result).toBe(false);
    });

    it('handles errors gracefully', async () => {
      (LocalNotifications.checkPermissions as jest.Mock).mockRejectedValue(new Error('Permission error'));

      const result = await requestNotificationPermission();

      expect(result).toBe(false);
    });
  });

  describe('showNoteReceivedNotification', () => {
    it('does nothing when not on mobile', async () => {
      mockIsMobile.mockReturnValue(false);

      await showNoteReceivedNotification('Title', 'Body');

      expect(hapticSuccess).not.toHaveBeenCalled();
      expect(LocalNotifications.schedule).not.toHaveBeenCalled();
    });

    it('triggers haptic feedback', async () => {
      await showNoteReceivedNotification('Title', 'Body');

      expect(hapticSuccess).toHaveBeenCalled();
    });

    it('cancels existing notification before scheduling new one', async () => {
      await showNoteReceivedNotification('Title', 'Body');

      expect(LocalNotifications.cancel).toHaveBeenCalledWith({
        notifications: [{ id: 1001 }]
      });
    });

    it('schedules notification with correct parameters', async () => {
      await showNoteReceivedNotification('Test Title', 'Test Body');

      expect(LocalNotifications.schedule).toHaveBeenCalledWith({
        notifications: [
          expect.objectContaining({
            id: 1001,
            title: 'Test Title',
            body: 'Test Body',
            autoCancel: true,
            channelId: 'miden_notes'
          })
        ]
      });
    });

    it('handles errors gracefully', async () => {
      (LocalNotifications.schedule as jest.Mock).mockRejectedValue(new Error('Schedule error'));

      await expect(showNoteReceivedNotification('Title', 'Body')).resolves.not.toThrow();
    });
  });

  describe('setupNotificationTapListener', () => {
    it('does nothing when not on mobile', async () => {
      mockIsMobile.mockReturnValue(false);

      await setupNotificationTapListener();

      expect(LocalNotifications.addListener).not.toHaveBeenCalled();
    });

    it('adds notification action listener', async () => {
      await setupNotificationTapListener();

      expect(LocalNotifications.addListener).toHaveBeenCalledWith(
        'localNotificationActionPerformed',
        expect.any(Function)
      );
    });

    it('handles notification tap and navigates', async () => {
      jest.useFakeTimers();

      let capturedCallback: ((action: any) => Promise<void>) | null = null;
      (LocalNotifications.addListener as jest.Mock).mockImplementation((_event, callback) => {
        capturedCallback = callback;
        return Promise.resolve();
      });

      await setupNotificationTapListener();

      expect(capturedCallback).not.toBeNull();

      // Simulate notification tap
      await capturedCallback!({
        notification: {
          extra: { navigateTo: '/receive' }
        }
      });

      jest.advanceTimersByTime(200);

      expect(navigate).toHaveBeenCalledWith('/receive');

      jest.useRealTimers();
    });

    it('closes all InAppBrowser instances if open when notification tapped', async () => {
      jest.useFakeTimers();

      (useWalletStore.getState as jest.Mock).mockReturnValue({ isDappBrowserOpen: true });

      let capturedCallback: ((action: any) => Promise<void>) | null = null;
      (LocalNotifications.addListener as jest.Mock).mockImplementation((_event, callback) => {
        capturedCallback = callback;
        return Promise.resolve();
      });

      await setupNotificationTapListener();

      await capturedCallback!({
        notification: {
          extra: { navigateTo: '/receive' }
        }
      });

      // PR-4 chunk 9: must call closeAll() so multi-instance dApps are
      // also torn down, not just the legacy default slot via close().
      expect(InAppBrowser.closeAll).toHaveBeenCalled();

      jest.useRealTimers();
    });

    it('handles errors gracefully', async () => {
      (LocalNotifications.addListener as jest.Mock).mockRejectedValue(new Error('Listener error'));

      await expect(setupNotificationTapListener()).resolves.not.toThrow();
    });
  });

  describe('initNativeNotifications', () => {
    it('does nothing when not on mobile', async () => {
      mockIsMobile.mockReturnValue(false);

      await initNativeNotifications();

      expect(LocalNotifications.checkPermissions).not.toHaveBeenCalled();
    });

    it('requests permission, creates channel, and sets up listener', async () => {
      (LocalNotifications.checkPermissions as jest.Mock).mockResolvedValue({ display: 'granted' });

      await initNativeNotifications();

      expect(LocalNotifications.checkPermissions).toHaveBeenCalled();
      expect(LocalNotifications.createChannel).toHaveBeenCalled();
      expect(LocalNotifications.addListener).toHaveBeenCalled();
    });

    it('does not create channel on iOS', async () => {
      mockIsAndroid.mockReturnValue(false);
      (LocalNotifications.checkPermissions as jest.Mock).mockResolvedValue({ display: 'granted' });

      await initNativeNotifications();

      expect(LocalNotifications.createChannel).not.toHaveBeenCalled();
    });
  });
});
