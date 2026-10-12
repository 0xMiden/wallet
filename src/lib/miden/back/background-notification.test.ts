import { isExtension } from 'lib/platform';

import {
  notifyBackgroundTransactionFailed,
  notifyBackgroundTransactionNotConfirmed,
  showBackgroundNotification
} from './background-notification';
import { getIntercom } from './defaults';

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
