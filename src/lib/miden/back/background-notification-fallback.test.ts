import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';
import { UserErrorId } from 'lib/telemetry/user-visible-error-contract';

import { showBackgroundNotification } from './background-notification';

jest.mock('lib/telemetry/user-visible-error', () => ({ reportUserVisibleError: jest.fn() }));
jest.mock('lib/platform', () => ({ isExtension: jest.fn() }));
jest.mock('./defaults', () => ({ getIntercom: jest.fn() }));
jest.mock('lib/i18n', () => ({ getMessage: () => '' }));

function observeDeliveryChain(attempt: Promise<void>) {
  const nativeThen = attempt.then.bind(attempt);
  void nativeThen(undefined, () => undefined);
  const successChildren: Promise<unknown>[] = [];
  const children: Promise<unknown>[] = [];

  // Follow the success-reporting child, without replacing native settlement or global methods.
  Object.defineProperty(attempt, 'then', {
    configurable: true,
    value: (onFulfilled?: ((value: void) => unknown) | null, onRejected?: ((reason: unknown) => unknown) | null) => {
      const successChild = nativeThen(onFulfilled, onRejected);
      successChildren.push(successChild);
      const nativeCatch = successChild.catch.bind(successChild);
      Object.defineProperty(successChild, 'catch', {
        configurable: true,
        value: (onRejected?: ((reason: unknown) => unknown) | null) => {
          const child = nativeCatch(onRejected);
          children.push(child);
          void child.catch(() => undefined);
          return child;
        }
      });
      return successChild;
    }
  });

  return { successChildren, children };
}

const errorIds: UserErrorId[] = ['transactionFailedNotificationBody', 'transactionNotConfirmedNotificationBody'];

describe.each(errorIds)('%s fallback containment', errorId => {
  it.each(['throw', 'reject'])('contains a Chrome transport throw after the service worker %s', async failure => {
    const chromeDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
    const registrationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'registration');
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const chromeError = new Error('Chrome notification transport unavailable');
    const create = jest.fn(() => {
      throw chromeError;
    });
    const attempt = Promise.reject(new TypeError('Service-worker notification transport unavailable'));
    const { successChildren, children } = observeDeliveryChain(attempt);
    jest.mocked(reportUserVisibleError).mockClear();

    try {
      Object.defineProperty(globalThis, 'chrome', {
        configurable: true,
        value: {
          runtime: { getURL: (path: string) => path, lastError: undefined },
          notifications: { create }
        }
      });
      const showNotification = jest.fn(() => {
        if (failure === 'throw') throw new TypeError('Service-worker notification transport unavailable');
        return attempt;
      });
      Object.defineProperty(globalThis, 'registration', {
        configurable: true,
        value: { showNotification }
      });

      let returned: unknown;
      expect(() => {
        returned = showBackgroundNotification('Title', 'Body', 'fallback-error-id', errorId);
      }).not.toThrow();
      expect(returned).toBeUndefined();
      expect(successChildren).toHaveLength(failure === 'reject' ? 1 : 0);
      expect(children).toHaveLength(failure === 'reject' ? 1 : 0);
      await Promise.allSettled(children);
      expect(showNotification).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledWith(
        'fallback-error-id',
        {
          type: 'basic',
          iconUrl: 'misc/logo-white-bg-128.png',
          title: 'Title',
          message: 'Body',
          requireInteraction: true
        },
        expect.any(Function)
      );
      await expect(Promise.all(children)).resolves.toEqual(failure === 'reject' ? [undefined] : []);
      expect(warning).toHaveBeenCalledWith('[background-notification] chrome.notifications error:', chromeError);
      expect(reportUserVisibleError).not.toHaveBeenCalled();
    } finally {
      if (chromeDescriptor) Object.defineProperty(globalThis, 'chrome', chromeDescriptor);
      else Reflect.deleteProperty(globalThis, 'chrome');
      if (registrationDescriptor) Object.defineProperty(globalThis, 'registration', registrationDescriptor);
      else Reflect.deleteProperty(globalThis, 'registration');
      warning.mockRestore();
    }
  });
});

it('observes successful service-worker reporting without starting a Chrome fallback', async () => {
  const chromeDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const registrationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'registration');
  const create = jest.fn();
  let resolveDelivery!: () => void;
  const attempt = new Promise<void>(resolve => {
    resolveDelivery = resolve;
  });
  const { successChildren, children } = observeDeliveryChain(attempt);
  const showNotification = jest.fn().mockReturnValue(attempt);
  jest.mocked(reportUserVisibleError).mockClear();

  try {
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: {
        runtime: { getURL: (path: string) => path, lastError: undefined },
        notifications: { create }
      }
    });
    Object.defineProperty(globalThis, 'registration', {
      configurable: true,
      value: { showNotification }
    });

    expect(
      showBackgroundNotification('Title', 'Body', 'success-id', 'transactionFailedNotificationBody')
    ).toBeUndefined();
    expect(successChildren).toHaveLength(1);
    expect(children).toHaveLength(1);
    expect(showNotification).toHaveBeenCalledWith('Title', {
      body: 'Body',
      icon: 'misc/logo-white-bg-128.png',
      requireInteraction: true
    });
    expect(reportUserVisibleError).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    resolveDelivery();
    await expect(children[0]).resolves.toBeUndefined();
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([
      ['transactionFailedNotificationBody', 'os_notification']
    ]);
    expect(create).not.toHaveBeenCalled();
  } finally {
    if (chromeDescriptor) Object.defineProperty(globalThis, 'chrome', chromeDescriptor);
    else Reflect.deleteProperty(globalThis, 'chrome');
    if (registrationDescriptor) Object.defineProperty(globalThis, 'registration', registrationDescriptor);
    else Reflect.deleteProperty(globalThis, 'registration');
  }
});

it('does not hide a rejection thrown by the observed native chain handler', async () => {
  const attempt = Promise.reject(new Error('Initial delivery rejected'));
  const { successChildren, children } = observeDeliveryChain(attempt);
  const handlerError = new Error('Uncontained fallback failure');
  const ignoredChild = attempt
    .then(() => undefined)
    .catch(() => {
      throw handlerError;
    });

  expect(successChildren).toHaveLength(1);
  expect(children).toHaveLength(1);
  expect(children[0]).toBe(ignoredChild);
  await expect(children[0]).rejects.toBe(handlerError);
});
