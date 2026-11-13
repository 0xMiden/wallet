const mockResume = jest.fn<Promise<void>, []>(async () => undefined);
jest.mock('lib/miden/platform-reset', () => ({ resumeExtensionReset: () => mockResume() }));
jest.mock('lib/platform', () => ({ isExtension: () => true }));
jest.mock('webextension-polyfill', () => ({ __esModule: true,
  default: { storage: { local: {} } } }));

beforeEach(() => {
  jest.resetModules();
  process.env.TARGET_BROWSER = 'chrome';
  mockResume.mockReset().mockResolvedValue(undefined);
});
it('waits for the authorized wipe even when old Chrome cannot restrict local storage', async () => {
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  mockResume.mockImplementationOnce(() => {
    entered();
    return new Promise<void>(resolve => { release = resolve; });
  });
  const { ensurePlatformUnlockStartup } = await import('./platform-unlock-startup');
  let ready = false;
  const starting = ensurePlatformUnlockStartup().then(() => { ready = true; });
  await Promise.race([reached, starting]);
  try { expect(ready).toBe(false); }
  finally { release(); await starting; }
});
it('propagates pending-reset failure and rechecks the protected intent on the next wake', async () => {
  mockResume.mockRejectedValueOnce(new Error('reset pending'));
  const { ensurePlatformUnlockStartup } = await import('./platform-unlock-startup');
  await expect(ensurePlatformUnlockStartup()).rejects.toThrow('reset pending');
  await expect(ensurePlatformUnlockStartup()).resolves.toBeUndefined();
});
