import {
  CARRIED_MAINNET_CODE_STORAGE_KEY,
  carryMainnetAccessCode,
  forgetCarriedMainnetAccessCode,
  readCarriedMainnetAccessCode
} from './carried-mainnet-code';

// The desktop store, over localStorage: like the mobile one, it parses what it stores as JSON.
jest.mock('lib/platform', () => ({ isMobile: () => false, isDesktop: () => true, isExtension: () => false }));
jest.mock('lib/platform/storage-adapter', () => {
  const actual = jest.requireActual<typeof import('lib/platform/storage-adapter')>('lib/platform/storage-adapter');
  const storage = new actual.DesktopStorage();
  return { ...actual, getStorageProvider: () => storage, default: () => storage };
});

describe('the mainnet access code carried through a switch', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    localStorage.clear();
  });

  it('reads back an all-digit code as the code it stored, not as a number', async () => {
    await carryMainnetAccessCode('47291835');
    await expect(readCarriedMainnetAccessCode()).resolves.toBe('47291835');
  });

  it('reads back a 12-character code with its letter case', async () => {
    await carryMainnetAccessCode('8gKIgL0O6HcU');
    await expect(readCarriedMainnetAccessCode()).resolves.toBe('8gKIgL0O6HcU');
  });

  it('reads nothing once forgotten', async () => {
    await carryMainnetAccessCode('8gKIgL0O6HcU');
    await forgetCarriedMainnetAccessCode();
    await expect(readCarriedMainnetAccessCode()).resolves.toBeUndefined();
    expect(Object.keys(localStorage).some(key => key.endsWith(CARRIED_MAINNET_CODE_STORAGE_KEY))).toBe(false);
  });

  it('reads nothing when no code was carried', async () => {
    await expect(readCarriedMainnetAccessCode()).resolves.toBeUndefined();
  });

  it('reads nothing, and does not reject, when storage cannot be read', async () => {
    await carryMainnetAccessCode('8gKIgL0O6HcU');
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage denied');
    });
    await expect(readCarriedMainnetAccessCode()).resolves.toBeUndefined();
  });

  it('does not reject when storage cannot forget the code', async () => {
    jest.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('storage denied');
    });
    await expect(forgetCarriedMainnetAccessCode()).resolves.toBeUndefined();
  });
});
