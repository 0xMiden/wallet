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

  // Only the hardware method authenticates without a credential. A password or
  // passcode challenge confirmed with nothing typed must never reach `verify`,
  // which answers a falsy credential by unlocking with the HARDWARE protector —
  // stepping the user up with a method this challenge did not select.
  it.each([
    ['no credential at all', undefined],
    ['an empty credential', '']
  ])('refuses a password challenge confirmed with %s, without verifying', async (_label, credential) => {
    const verify = jest.fn().mockResolvedValue(undefined);
    const challenge = createStrictActionAuthenticationController({
      getPlatform: () => 'extension',
      loadProtectors: jest.fn().mockResolvedValue({ hardware: false, password: true }),
      verify
    }).begin();

    await expect(challenge.authenticate(credential)).resolves.toBe('cancelled');
    expect(verify).not.toHaveBeenCalled();
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

describe('Task5 recovery authenticated action', () => {
  it.each([
    { platform: 'mobile', hardware: true, credential: undefined },
    { platform: 'extension', hardware: false, credential: 'disposable-credential' }
  ])(
    'performs one backend-authenticated operation on $platform without a separate verification',
    async ({ platform, hardware, credential }) => {
      const verify = jest.fn().mockResolvedValue(undefined);
      const perform = jest.fn().mockResolvedValue(undefined);
      const selected: StrictAuthenticationPlatform = platform === 'mobile' ? 'mobile' : 'extension';
      const challenge = createStrictActionAuthenticationController({
        getPlatform: () => selected,
        loadProtectors: async () => ({ hardware, password: !hardware }),
        verify,
        perform
      }).begin();
      await expect(challenge.authenticate(credential)).resolves.toBe('authenticated');
      expect(perform).toHaveBeenCalledTimes(1);
      expect(perform).toHaveBeenCalledWith(credential);
      expect(verify).not.toHaveBeenCalled();
    }
  );

  it('coalesces repeated confirmation into the same authenticated operation', async () => {
    const work = deferred<void>();
    const perform = jest.fn(() => work.promise);
    const verify = jest.fn().mockResolvedValue(undefined);
    const challenge = createStrictActionAuthenticationController({
      getPlatform: () => 'extension',
      loadProtectors: async () => ({ hardware: false, password: true }),
      verify,
      perform
    }).begin();
    const first = challenge.authenticate('disposable-credential');
    const second = challenge.authenticate('disposable-credential');
    work.resolve();
    await expect(first).resolves.toBe('authenticated');
    await expect(second).resolves.toBe('authenticated');
    expect(perform).toHaveBeenCalledTimes(1);
    expect(verify).not.toHaveBeenCalled();
  });

  it('retires a late authenticated operation result when the challenge is cancelled', async () => {
    const work = deferred<void>();
    const perform = jest.fn(() => work.promise);
    const challenge = createStrictActionAuthenticationController({
      getPlatform: () => 'mobile',
      loadProtectors: async () => ({ hardware: true, password: false }),
      verify: jest.fn().mockResolvedValue(undefined),
      perform
    }).begin();
    const result = challenge.authenticate();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(perform).toHaveBeenCalledTimes(1);
    challenge.cancel();
    work.resolve();
    await expect(result).resolves.toBe('cancelled');
  });
});
