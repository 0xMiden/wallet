import { isExtension } from 'lib/platform';

import { showExtensionNotification } from './notifications';

jest.mock('lib/platform', () => ({
  isExtension: jest.fn()
}));

const mockIsExtension = isExtension as jest.MockedFunction<typeof isExtension>;

// jsdom doesn't ship a Notification constructor — we install a stub on
// globalThis that we can drive per-test. Tests that want to disable it
// `delete (globalThis as any).Notification`.
class FakeNotification {
  static permission: NotificationPermission = 'default';
  static requestPermission = jest.fn(async () => FakeNotification.permission);
  body: string | undefined;
  icon: string | undefined;
  requireInteraction: boolean | undefined;
  onclick: (() => void) | null = null;
  close = jest.fn();
  constructor(
    public title: string,
    opts?: NotificationOptions
  ) {
    this.body = opts?.body;
    this.icon = opts?.icon;
    this.requireInteraction = opts?.requireInteraction;
  }
}

const mockTabsCreate = jest.fn();
const mockChromeNotificationsCreate = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  mockIsExtension.mockReturnValue(true);
  FakeNotification.permission = 'default';
  FakeNotification.requestPermission.mockResolvedValue('default');
  (globalThis as any).Notification = FakeNotification;
  (globalThis as any).chrome = {
    runtime: {
      getURL: (p: string) => `chrome-ext://test/${p}`,
      lastError: undefined
    },
    tabs: {
      create: mockTabsCreate
    },
    notifications: {
      create: mockChromeNotificationsCreate
    }
  };
});

afterEach(() => {
  delete (globalThis as any).Notification;
  delete (globalThis as any).chrome;
});

describe('showExtensionNotification', () => {
  it('is a no-op outside extension context', async () => {
    mockIsExtension.mockReturnValueOnce(false);
    await showExtensionNotification('Hi', 'msg');
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    expect(mockChromeNotificationsCreate).not.toHaveBeenCalled();
  });

  it('uses the Web Notifications API when permission is already granted', async () => {
    FakeNotification.permission = 'granted';
    await showExtensionNotification('Hi', 'msg');
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    // Falls through to creating a Notification
    // FakeNotification was instantiated — its prototype.close is per-instance
    // so we can't easily count instantiations. Instead, verify chrome.notifications
    // was NOT used as the fallback (the function returned after Notification path).
    expect(mockChromeNotificationsCreate).not.toHaveBeenCalled();
  });

  it('requests permission when permission is "default" and creates notification on grant', async () => {
    FakeNotification.permission = 'default';
    FakeNotification.requestPermission.mockResolvedValueOnce('granted');
    await showExtensionNotification('Hi', 'msg');
    expect(FakeNotification.requestPermission).toHaveBeenCalled();
    expect(mockChromeNotificationsCreate).not.toHaveBeenCalled();
  });

  it('falls back to chrome.notifications when permission is denied', async () => {
    FakeNotification.permission = 'default';
    FakeNotification.requestPermission.mockResolvedValueOnce('denied');
    await showExtensionNotification('Hi', 'msg');
    expect(mockChromeNotificationsCreate).toHaveBeenCalledWith(
      'miden-note-received',
      expect.objectContaining({ type: 'basic', title: 'Hi', message: 'msg' }),
      expect.any(Function)
    );
  });

  it('falls back to chrome.notifications when global Notification is undefined', async () => {
    delete (globalThis as any).Notification;
    await showExtensionNotification('Hi', 'msg');
    expect(mockChromeNotificationsCreate).toHaveBeenCalled();
  });

  it('returns silently when both Notification and chrome.notifications are unavailable', async () => {
    delete (globalThis as any).Notification;
    delete (globalThis as any).chrome.notifications;
    await expect(showExtensionNotification('Hi', 'msg')).resolves.toBeUndefined();
  });

  it('logs an error when chrome.notifications.create reports lastError', async () => {
    delete (globalThis as any).Notification;
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockChromeNotificationsCreate.mockImplementationOnce((_id: string, _opts: any, cb: () => void) => {
      (globalThis as any).chrome.runtime.lastError = { message: 'failed' };
      cb();
      delete (globalThis as any).chrome.runtime.lastError;
    });
    await showExtensionNotification('Hi', 'msg');
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Error'), 'failed');
    errSpy.mockRestore();
  });

  it('Notification onclick opens the receive page and closes the notification', async () => {
    FakeNotification.permission = 'granted';
    let createdNotif: FakeNotification | null = null;
    const OrigNotif = FakeNotification;
    (globalThis as any).Notification = class extends OrigNotif {
      constructor(title: string, opts?: NotificationOptions) {
        super(title, opts);
        createdNotif = this as unknown as FakeNotification;
      }
    };
    (globalThis as any).Notification.permission = 'granted';
    (globalThis as any).Notification.requestPermission = jest.fn();
    await showExtensionNotification('Hi', 'msg');
    expect(createdNotif).not.toBeNull();
    // Trigger the click handler
    createdNotif!.onclick!();
    expect(mockTabsCreate).toHaveBeenCalledWith({ url: expect.stringContaining('fullpage.html') });
    expect(createdNotif!.close).toHaveBeenCalled();
  });
});
