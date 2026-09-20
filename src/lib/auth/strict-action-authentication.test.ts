import {
  StrictAuthenticationPlatform,
  createStrictActionAuthenticationController
} from './strict-action-authentication';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => {
    resolve = next;
  });
  return { promise, resolve };
};

describe('strict action authentication controller', () => {
  it.each([
    ['mobile hardware', 'mobile', true, false, 'hardware'],
    ['mobile passcode', 'mobile', false, true, 'passcode'],
    ['extension password', 'extension', false, true, 'password'],
    ['desktop password', 'desktop', false, true, 'password'],
    ['desktop hardware', 'desktop', true, false, 'hardware']
  ] as const)('selects %s', async (_label, platform, hardware, password, expected) => {
    const controller = createStrictActionAuthenticationController({
      getPlatform: () => platform as StrictAuthenticationPlatform,
      loadProtectors: jest.fn().mockResolvedValue({ hardware, password }),
      verify: jest.fn().mockResolvedValue(undefined)
    });

    await expect(controller.begin().method).resolves.toBe(expected);
  });

  it('fails closed when no protector is configured or the probe fails', async () => {
    const verify = jest.fn();
    const missing = createStrictActionAuthenticationController({
      getPlatform: () => 'extension',
      loadProtectors: jest.fn().mockResolvedValue({ hardware: false, password: false }),
      verify
    }).begin();
    const failed = createStrictActionAuthenticationController({
      getPlatform: () => 'desktop',
      loadProtectors: jest.fn().mockRejectedValue(new Error('storage offline')),
      verify
    }).begin();

    await expect(missing.method).resolves.toBeUndefined();
    await expect(missing.authenticate('secret')).resolves.toBe('cancelled');
    await expect(failed.method).resolves.toBeUndefined();
    await expect(failed.authenticate()).resolves.toBe('cancelled');
    expect(verify).not.toHaveBeenCalled();
  });

  it('passes no credential to hardware verification and denies invalid credentials', async () => {
    const hardwareVerify = jest.fn().mockResolvedValue(undefined);
    const hardware = createStrictActionAuthenticationController({
      getPlatform: () => 'mobile',
      loadProtectors: jest.fn().mockResolvedValue({ hardware: true, password: false }),
      verify: hardwareVerify
    }).begin();
    const password = createStrictActionAuthenticationController({
      getPlatform: () => 'extension',
      loadProtectors: jest.fn().mockResolvedValue({ hardware: false, password: true }),
      verify: jest.fn().mockRejectedValue(new Error('invalid password'))
    }).begin();

    await expect(hardware.authenticate('ignored')).resolves.toBe('authenticated');
    expect(hardwareVerify).toHaveBeenCalledWith(undefined);
    await expect(password.authenticate('wrong')).resolves.toBe('cancelled');
  });

  it('coalesces duplicate confirmation into one verification', async () => {
    const verification = deferred<void>();
    const verify = jest.fn(() => verification.promise);
    const challenge = createStrictActionAuthenticationController({
      getPlatform: () => 'extension',
      loadProtectors: jest.fn().mockResolvedValue({ hardware: false, password: true }),
      verify
    }).begin();

    const first = challenge.authenticate('secret');
    const second = challenge.authenticate('secret');
    verification.resolve();

    await expect(first).resolves.toBe('authenticated');
    await expect(second).resolves.toBe('authenticated');
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('denies completion after cancellation or a newer challenge', async () => {
    const firstVerification = deferred<void>();
    const secondVerification = deferred<void>();
    const verify = jest
      .fn()
      .mockImplementationOnce(() => firstVerification.promise)
      .mockImplementationOnce(() => secondVerification.promise);
    const controller = createStrictActionAuthenticationController({
      getPlatform: () => 'extension',
      loadProtectors: jest.fn().mockResolvedValue({ hardware: false, password: true }),
      verify
    });
    const cancelled = controller.begin();
    const cancelledResult = cancelled.authenticate('first');
    cancelled.cancel();
    firstVerification.resolve();

    await expect(cancelledResult).resolves.toBe('cancelled');

    const stale = controller.begin();
    const staleResult = stale.authenticate('second');
    const current = controller.begin();
    secondVerification.resolve();

    await expect(staleResult).resolves.toBe('cancelled');
    await expect(current.method).resolves.toBe('password');
  });
});
