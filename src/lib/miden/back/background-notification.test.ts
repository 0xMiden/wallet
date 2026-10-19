import { isExtension } from 'lib/platform';
import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';

import {
  notifyBackgroundTransactionFailed,
  notifyBackgroundTransactionNotConfirmed,
  showBackgroundNotification
} from './background-notification';
import { getIntercom } from './defaults';

jest.mock('lib/telemetry/user-visible-error', () => ({ reportUserVisibleError: jest.fn() }));
jest.mock('lib/platform', () => ({ isExtension: jest.fn() }));
jest.mock('./defaults', () => ({ getIntercom: jest.fn() }));
// getMessage returns '' so the English `|| fallback` copy is exercised.
jest.mock('lib/i18n', () => ({ getMessage: () => '' }));

const mockIsExtension = isExtension as jest.Mock;
const mockGetIntercom = getIntercom as jest.Mock;

const NOT_CONFIRMED_BODY =
  'The wallet could not confirm whether a transaction went through. Open the wallet before you try again.';

const notificationsCreate = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  // No SW `registration` in jsdom → the chrome.notifications fallback path runs.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).registration;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).chrome = {
    runtime: { getURL: (p: string) => p, lastError: undefined },
    notifications: { create: notificationsCreate }
  };
});

describe('showBackgroundNotification', () => {
  it('fires a chrome.notifications entry with the given id', () => {
    showBackgroundNotification('Title', 'Body', 'some-id');
    expect(notificationsCreate).toHaveBeenCalledWith(
      'some-id',
      expect.objectContaining({ title: 'Title', message: 'Body' }),
      expect.any(Function)
    );
  });
});

describe('notifyBackgroundTransactionFailed (gap 6)', () => {
  it('does NOT notify off the extension', () => {
    mockIsExtension.mockReturnValue(false);
    mockGetIntercom.mockReturnValue({ hasClients: () => false });

    notifyBackgroundTransactionFailed();

    expect(notificationsCreate).not.toHaveBeenCalled();
  });

  it('does NOT notify when a wallet popup is open (the user already sees the failure)', () => {
    mockIsExtension.mockReturnValue(true);
    mockGetIntercom.mockReturnValue({ hasClients: () => true });

    notifyBackgroundTransactionFailed();

    expect(notificationsCreate).not.toHaveBeenCalled();
  });

  it('notifies on a background failure when no wallet UI is open', () => {
    mockIsExtension.mockReturnValue(true);
    mockGetIntercom.mockReturnValue({ hasClients: () => false });

    notifyBackgroundTransactionFailed();

    expect(notificationsCreate).toHaveBeenCalledTimes(1);
    expect(notificationsCreate).toHaveBeenCalledWith(
      'miden-transaction-failed',
      expect.objectContaining({ title: 'Transaction failed' }),
      expect.any(Function)
    );
  });

  it('swallows an intercom error rather than disturbing the caller', () => {
    mockIsExtension.mockReturnValue(true);
    mockGetIntercom.mockImplementation(() => {
      throw new Error('no intercom');
    });

    expect(() => notifyBackgroundTransactionFailed()).not.toThrow();
    expect(notificationsCreate).not.toHaveBeenCalled();
  });
});

// Same gating as the failure notice, with copy that does not claim the transaction failed (#1250).
describe('notifyBackgroundTransactionNotConfirmed', () => {
  it('does NOT notify off the extension', () => {
    mockIsExtension.mockReturnValue(false);
    mockGetIntercom.mockReturnValue({ hasClients: () => false });

    notifyBackgroundTransactionNotConfirmed();

    expect(notificationsCreate).not.toHaveBeenCalled();
  });

  it('does NOT notify when a wallet popup is open', () => {
    mockIsExtension.mockReturnValue(true);
    mockGetIntercom.mockReturnValue({ hasClients: () => true });

    notifyBackgroundTransactionNotConfirmed();

    expect(notificationsCreate).not.toHaveBeenCalled();
  });

  it('notifies with the not-confirmed title and body when no wallet UI is open', () => {
    mockIsExtension.mockReturnValue(true);
    mockGetIntercom.mockReturnValue({ hasClients: () => false });

    notifyBackgroundTransactionNotConfirmed();

    expect(notificationsCreate).toHaveBeenCalledTimes(1);
    expect(notificationsCreate).toHaveBeenCalledWith(
      'miden-transaction-not-confirmed',
      expect.objectContaining({
        title: 'Transaction not confirmed',
        message: NOT_CONFIRMED_BODY
      }),
      expect.any(Function)
    );
  });

  // The fallback is the English the locale file ships, so a missing message never reads differently (#1081).
  it('falls back to the en.json body verbatim, and the hint names no transaction type', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const en: Record<string, unknown> = require('../../../../public/_locales/en/en.json');
    expect(en.transactionNotConfirmedNotificationBody).toBe(NOT_CONFIRMED_BODY);
    expect(en.transactionNotConfirmedHint).toBe(
      'The wallet could not confirm whether this went through. It may still complete, so check the wallet after it syncs before you try again.'
    );
  });

  it('swallows an intercom error rather than disturbing the caller', () => {
    mockIsExtension.mockReturnValue(true);
    mockGetIntercom.mockImplementation(() => {
      throw new Error('no intercom');
    });

    expect(() => notifyBackgroundTransactionNotConfirmed()).not.toThrow();
    expect(notificationsCreate).not.toHaveBeenCalled();
  });
});

describe('delivered background transaction error reporting', () => {
  const variants = [
    {
      name: 'failed',
      notify: notifyBackgroundTransactionFailed,
      id: 'transactionFailedNotificationBody',
      notificationId: 'miden-transaction-failed',
      title: 'Transaction failed',
      body: "A transaction couldn't be completed. Open the wallet to review."
    },
    {
      name: 'unconfirmed',
      notify: notifyBackgroundTransactionNotConfirmed,
      id: 'transactionNotConfirmedNotificationBody',
      notificationId: 'miden-transaction-not-confirmed',
      title: 'Transaction not confirmed',
      body: 'The wallet could not confirm whether a transaction went through. Open the wallet before you try again.'
    }
  ];
  type NotificationPlatform = {
    registration?: { showNotification: jest.Mock };
    chrome: {
      runtime: { getURL: (path: string) => string; lastError?: { message: string } };
      notifications?: { create: jest.Mock };
    };
  };
  const platform = globalThis as unknown as NotificationPlatform;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    mockIsExtension.mockReturnValue(true);
    mockGetIntercom.mockReturnValue({ hasClients: () => false });
    notificationsCreate.mockReset();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
    delete platform.registration;
  });

  describe.each(variants)('$name notification', ({ notify, id, notificationId, title, body }) => {
    it('reports exactly once after Chrome confirms delivery with the original copy', () => {
      notify();
      expect(notificationsCreate.mock.calls).toEqual([
        [
          notificationId,
          { type: 'basic', iconUrl: 'misc/logo-white-bg-128.png', title, message: body, requireInteraction: true },
          expect.any(Function)
        ]
      ]);
      expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([]);
      const delivered = notificationsCreate.mock.calls[0][2] as (createdId: string) => void;
      delivered(notificationId);
      expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([[id, 'os_notification']]);
    });

    it('reports only after the service-worker delivery promise resolves', async () => {
      let resolveDelivery!: () => void;
      const delivery = new Promise<void>(resolve => {
        resolveDelivery = resolve;
      });
      const showNotification = jest.fn().mockReturnValue(delivery);
      platform.registration = { showNotification };
      notify();
      expect(showNotification.mock.calls).toEqual([
        [title, { body, icon: 'misc/logo-white-bg-128.png', requireInteraction: true }]
      ]);
      expect(notificationsCreate).not.toHaveBeenCalled();
      expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([]);
      resolveDelivery();
      await delivery;
      await Promise.resolve();
      expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([[id, 'os_notification']]);
    });

    it('keeps an undelivered Chrome notification quiet', () => {
      notify();
      expect(notificationsCreate).toHaveBeenCalledTimes(1);
      expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([]);
    });

    it('keeps a Chrome delivery error quiet and preserves its diagnostic', () => {
      notify();
      const error = { message: 'private notification transport detail 0x1234 amount 42' };
      platform.chrome.runtime.lastError = error;
      const completed = notificationsCreate.mock.calls[0][2] as (createdId: string) => void;
      completed('');
      expect(warnSpy).toHaveBeenCalledWith('[background-notification] chrome.notifications error:', error.message);
      expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([]);
    });

    it('keeps a rejected service-worker delivery quiet', async () => {
      const error = new Error('private notification rejection 0x1234 amount 42');
      const delivery = Promise.reject(error);
      // The platform rejection is observed even on the uninstrumented baseline.
      void delivery.catch(() => undefined);
      platform.registration = { showNotification: jest.fn().mockReturnValue(delivery) };
      expect(() => notify()).not.toThrow();
      await delivery.catch(() => undefined);
      await Promise.resolve();
      expect(notificationsCreate).not.toHaveBeenCalled();
      expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([]);
    });

    it('keeps a synchronously rejected delivery quiet without escaping the caller', () => {
      const error = new Error('platform unavailable');
      notificationsCreate.mockImplementationOnce(() => {
        throw error;
      });
      expect(() => notify()).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[background-notification]'), error);
      expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([]);
    });

    it('keeps off-extension and attached-client gates quiet', () => {
      mockIsExtension.mockReturnValue(false);
      notify();
      mockIsExtension.mockReturnValue(true);
      mockGetIntercom.mockReturnValue({ hasClients: () => true });
      notify();
      expect(notificationsCreate).not.toHaveBeenCalled();
      expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([]);
    });

    it('keeps missing OS notification transports quiet', () => {
      delete platform.chrome.notifications;
      notify();
      expect(notificationsCreate).not.toHaveBeenCalled();
      expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([]);
    });
  });

  it('keeps non-error notification copy quiet even after delivery', () => {
    showBackgroundNotification('Received a note', 'Informational success', 'miden-received-note');
    const completed = notificationsCreate.mock.calls[0][2] as (createdId: string) => void;
    completed('miden-received-note');
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([]);
  });
});
