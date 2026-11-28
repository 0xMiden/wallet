import { LocalNotifications } from '@capacitor/local-notifications';

import { hapticSuccess } from 'lib/mobile/haptics';

import {
  DEPOSIT_ARRIVED_NOTIFICATION_ID,
  DEPOSIT_ARRIVED_NOTIFICATION_TYPE,
  showDepositArrivalNotice
} from './deposit-arrival-notice';

const mockPlatform = { mobile: false, extension: false };

jest.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    checkPermissions: jest.fn(),
    cancel: jest.fn(),
    schedule: jest.fn()
  }
}));
jest.mock('lib/mobile/haptics', () => ({ hapticSuccess: jest.fn() }));
jest.mock('lib/platform', () => ({
  isMobile: () => mockPlatform.mobile,
  isExtension: () => mockPlatform.extension
}));

const NOTICE = {
  title: 'Bread',
  body: 'We see your deposit. Tap to follow it.',
  path: '/bridge/deposit?pending=d1',
  tag: 'deposit-arrived:d1'
};

const mockCheckPermissions = jest.mocked(LocalNotifications.checkPermissions);
const mockSchedule = jest.mocked(LocalNotifications.schedule);
const mockCancel = jest.mocked(LocalNotifications.cancel);

interface CreatedNotification {
  title: string;
  options?: NotificationOptions;
  onclick: (() => void) | null;
  close: jest.Mock;
}

let created: CreatedNotification[] = [];
let permission: NotificationPermission = 'granted';

class FakeNotification implements CreatedNotification {
  static get permission(): NotificationPermission {
    return permission;
  }
  onclick: (() => void) | null = null;
  close = jest.fn();
  constructor(
    public title: string,
    public options?: NotificationOptions
  ) {
    created.push(this);
  }
}

const chromeStub = {
  runtime: { getURL: (path: string) => `chrome-extension://id/${path}`, lastError: undefined },
  tabs: { create: jest.fn() },
  notifications: { create: jest.fn() }
};

const originalNotification = Object.getOwnPropertyDescriptor(globalThis, 'Notification');

beforeEach(() => {
  mockPlatform.mobile = false;
  mockPlatform.extension = false;
  created = [];
  permission = 'granted';
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: chromeStub });
  Object.defineProperty(globalThis, 'Notification', { configurable: true, writable: true, value: FakeNotification });
  mockCheckPermissions.mockResolvedValue({ display: 'granted' });
  mockSchedule.mockResolvedValue({ notifications: [] });
  mockCancel.mockResolvedValue(undefined);
});

afterEach(() => {
  jest.clearAllMocks();
  Reflect.deleteProperty(globalThis, 'chrome');
  if (originalNotification) Object.defineProperty(globalThis, 'Notification', originalNotification);
  else Reflect.deleteProperty(globalThis, 'Notification');
});

describe('showDepositArrivalNotice', () => {
  describe('mobile', () => {
    beforeEach(() => {
      mockPlatform.mobile = true;
    });

    it('schedules a native notice whose tap opens the deposit', async () => {
      await showDepositArrivalNotice(NOTICE);

      expect(hapticSuccess).toHaveBeenCalledTimes(1);
      expect(mockCancel).toHaveBeenCalledWith({ notifications: [{ id: DEPOSIT_ARRIVED_NOTIFICATION_ID }] });
      expect(mockSchedule).toHaveBeenCalledWith({
        notifications: [
          expect.objectContaining({
            id: DEPOSIT_ARRIVED_NOTIFICATION_ID,
            title: NOTICE.title,
            body: NOTICE.body,
            channelId: 'miden_notes',
            extra: { type: DEPOSIT_ARRIVED_NOTIFICATION_TYPE, navigateTo: NOTICE.path }
          })
        ]
      });
    });

    it('shows nothing while notifications are off', async () => {
      mockCheckPermissions.mockResolvedValue({ display: 'denied' });
      await showDepositArrivalNotice(NOTICE);
      expect(mockSchedule).not.toHaveBeenCalled();
      expect(hapticSuccess).not.toHaveBeenCalled();
    });

    it('never throws', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockSchedule.mockRejectedValue(new Error('plugin'));
      await expect(showDepositArrivalNotice(NOTICE)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe('extension', () => {
    beforeEach(() => {
      mockPlatform.extension = true;
    });

    it('shows a Web notice whose click opens the deposit in a wallet tab', async () => {
      await showDepositArrivalNotice(NOTICE);

      expect(created).toHaveLength(1);
      const [notice] = created;
      expect(notice?.title).toBe(NOTICE.title);
      expect(notice?.options).toEqual(
        expect.objectContaining({ body: NOTICE.body, tag: NOTICE.tag, requireInteraction: true })
      );
      notice?.onclick?.();
      expect(chromeStub.tabs.create).toHaveBeenCalledWith({
        url: 'chrome-extension://id/fullpage.html#/bridge/deposit?pending=d1'
      });
      expect(notice?.close).toHaveBeenCalled();
      expect(chromeStub.notifications.create).not.toHaveBeenCalled();
    });

    it('shows nothing while notifications are off', async () => {
      permission = 'denied';
      await showDepositArrivalNotice(NOTICE);
      expect(created).toHaveLength(0);
      expect(chromeStub.notifications.create).not.toHaveBeenCalled();
    });

    it('falls back to chrome.notifications without the Web API', async () => {
      Reflect.deleteProperty(globalThis, 'Notification');
      await showDepositArrivalNotice(NOTICE);
      expect(chromeStub.notifications.create).toHaveBeenCalledWith(
        'miden-deposit-arrived',
        expect.objectContaining({ title: NOTICE.title, message: NOTICE.body }),
        expect.any(Function)
      );
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const done: unknown = chromeStub.notifications.create.mock.calls[0]?.[2];
      if (typeof done !== 'function') throw new Error('no callback');
      done();
      expect(warn).not.toHaveBeenCalled();
      Object.defineProperty(chromeStub.runtime, 'lastError', { configurable: true, value: { message: 'off' } });
      done();
      expect(warn).toHaveBeenCalledWith(expect.any(String), 'off');
      Object.defineProperty(chromeStub.runtime, 'lastError', { configurable: true, value: undefined });
      warn.mockRestore();
    });
  });

  it('shows nothing on another platform', async () => {
    await showDepositArrivalNotice(NOTICE);
    expect(mockSchedule).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });
});
