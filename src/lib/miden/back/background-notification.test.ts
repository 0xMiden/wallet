import { isExtension } from 'lib/platform';

import { notifyBackgroundTransactionFailed, showBackgroundNotification } from './background-notification';
import { getIntercom } from './defaults';

jest.mock('lib/platform', () => ({ isExtension: jest.fn() }));
jest.mock('./defaults', () => ({ getIntercom: jest.fn() }));
// getMessage returns '' so the English `|| fallback` copy is exercised.
jest.mock('lib/i18n', () => ({ getMessage: () => '' }));

const mockIsExtension = isExtension as jest.Mock;
const mockGetIntercom = getIntercom as jest.Mock;

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
