import { showBackgroundNotification } from './background-notification';

jest.mock('lib/platform', () => ({ isExtension: jest.fn() }));
jest.mock('./defaults', () => ({ getIntercom: jest.fn() }));
jest.mock('lib/i18n', () => ({ getMessage: () => '' }));

it('contains a Chrome transport throw after a rejected service-worker notification', async () => {
  const chromeDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const registrationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'registration');
  const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  const chromeError = new Error('Chrome notification transport unavailable');
  const create = jest.fn(() => {
    throw chromeError;
  });
  const attempt = Promise.reject(new TypeError('Service-worker notification transport unavailable'));
  const nativeCatch = attempt.catch.bind(attempt);
  void nativeCatch(() => undefined);
  const children: Promise<unknown>[] = [];

  // Observe the real ignored child and handle its rejection without changing its settlement.
  // Only this fixture promise has an observer; the native Promise methods remain untouched.
  Object.defineProperty(attempt, 'catch', {
    configurable: true,
    value: (onRejected?: ((reason: unknown) => unknown) | null) => {
      const child = nativeCatch(onRejected);
      children.push(child);
      void child.catch(() => undefined);
      return child;
    }
  });

  try {
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: {
        runtime: { getURL: (path: string) => path, lastError: undefined },
        notifications: { create }
      }
    });
    const showNotification = jest.fn().mockReturnValue(attempt);
    Object.defineProperty(globalThis, 'registration', {
      configurable: true,
      value: { showNotification }
    });

    expect(showBackgroundNotification('Title', 'Body', 'fallback-error-id')).toBeUndefined();
    expect(children).toHaveLength(1);
    await Promise.resolve();
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
    await expect(children[0]).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledWith('[background-notification] chrome.notifications error:', chromeError);
  } finally {
    if (chromeDescriptor) Object.defineProperty(globalThis, 'chrome', chromeDescriptor);
    else Reflect.deleteProperty(globalThis, 'chrome');
    if (registrationDescriptor) Object.defineProperty(globalThis, 'registration', registrationDescriptor);
    else Reflect.deleteProperty(globalThis, 'registration');
    warning.mockRestore();
  }
});
