const mockSetAccessLevel = jest.fn(async (_options: { accessLevel: string }) => undefined);
const mockLocal: { setAccessLevel?: typeof mockSetAccessLevel } = { setAccessLevel: mockSetAccessLevel };
const mockSupport = jest.fn(async () => true);
let mockExtension = true;
jest.mock('webextension-polyfill', () => ({ __esModule: true, default: { storage: { local: mockLocal } } }));
jest.mock('lib/platform', () => ({ isExtension: () => mockExtension }));
jest.mock('lib/platform-auth/capabilities', () => ({ getPlatformUnlockSupport: () => mockSupport() }));

beforeEach(() => {
  jest.resetModules(); mockExtension = true; process.env.TARGET_BROWSER = 'chrome';
  mockSetAccessLevel.mockReset().mockResolvedValue(undefined);
  mockSupport.mockReset().mockResolvedValue(true);
  mockLocal.setAccessLevel = mockSetAccessLevel;
});

it('enables the new path only after trusted-context protection has succeeded', async () => {
  const boot = await import('./platform-unlock-startup');
  await expect(boot.getPlatformUnlockAvailability()).resolves.toBe(true);
  expect(mockSetAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
  await boot.ensureTrustedPlatformStorage();
  expect(mockSetAccessLevel).toHaveBeenCalledTimes(1);
});
it('leaves old-browser password operation independent of unsupported isolation', async () => {
  Reflect.deleteProperty(mockLocal, 'setAccessLevel');
  const boot = await import('./platform-unlock-startup');
  await expect(boot.getPlatformUnlockAvailability()).resolves.toBe(false);
});
it('does not claim protection after a browser rejection', async () => {
  mockSetAccessLevel.mockRejectedValueOnce(new Error('not supported'));
  const boot = await import('./platform-unlock-startup');
  await expect(boot.getPlatformUnlockAvailability()).resolves.toBe(false);
});
it('still restricts storage on an OS that is not offered passkeys', async () => {
  mockSupport.mockResolvedValueOnce(false);
  const boot = await import('./platform-unlock-startup');
  await expect(boot.getPlatformUnlockAvailability()).resolves.toBe(false);
  expect(mockSetAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
});
it('does not invoke extension APIs on native apps', async () => {
  mockExtension = false;
  const boot = await import('./platform-unlock-startup');
  await expect(boot.getPlatformUnlockAvailability()).resolves.toBe(false);
  expect(mockSetAccessLevel).not.toHaveBeenCalled();
});
