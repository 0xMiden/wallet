import Dexie from 'dexie';

import { getAccountsWriteQueue } from 'lib/miden/back/accounts-write-queue';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { PLATFORM_CREDENTIALS_STORAGE_KEY, PLATFORM_RESET_STORAGE_KEY } from 'lib/platform-auth/types';

import { authorizeExtensionReset, performAuthorizedExtensionReset, resumeExtensionReset } from './platform-reset';

const mockData = new Map<string, unknown>();
let mockWipeFailure = false;
const mockSteps: string[] = [];
const mockWipe = jest.fn(async (_options: { keepEndpointOverride: boolean }) => {
  mockSteps.push('wipe');
  if (mockWipeFailure) throw new Error('wipe failed');
  for (const key of mockData.keys()) {
    if (![PLATFORM_CREDENTIALS_STORAGE_KEY, PLATFORM_RESET_STORAGE_KEY].includes(key)) mockData.delete(key);
  }
});
const mockLock = jest.fn(async () => {
  mockSteps.push('lock');
});
const mockApplyNetwork = jest.fn(async () => {
  mockSteps.push('network');
});
const mockCarry = jest.fn(async (_code: string) => {
  mockSteps.push('code');
});
let mockMarkerRemovalFailure = false;
jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async (keys: string[]) => Object.fromEntries(keys.map(key => [key, mockData.get(key)])),
    set: async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) mockData.set(key, value);
    },
    remove: async (keys: string[]) => {
      if (mockMarkerRemovalFailure && keys.includes(PLATFORM_RESET_STORAGE_KEY)) throw new Error('marker retained');
      for (const key of keys) mockData.delete(key);
    }
  })
}));
jest.mock('lib/miden/reset', () => ({
  resetStorageDestructive: (options: { keepEndpointOverride: boolean }) => mockWipe(options)
}));
jest.mock('lib/miden/back/actions', () => ({ lockForResetInTurn: () => mockLock() }));
jest.mock('lib/carried-mainnet-code', () => ({ carryMainnetAccessCode: (code: string) => mockCarry(code) }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  buildNetworkChoiceOverride: (network: MIDEN_NETWORK_NAME) => ({ networkName: network }),
  applyEndpointOverride: () => mockApplyNetwork()
}));

beforeEach(async () => {
  await Dexie.delete('miden-platform-unlock-reset');
  mockData.clear();
  mockData.set('vault_key_password', 'fixture protector');
  mockSteps.length = 0;
  mockWipeFailure = false;
  mockMarkerRemovalFailure = false;
  mockWipe.mockClear();
  mockLock.mockClear();
  mockApplyNetwork.mockClear();
  mockCarry.mockClear();
});
afterEach(async () => {
  await getAccountsWriteQueue().onIdle();
  await Dexie.delete('miden-platform-unlock-reset');
});

it('does not authorize a wipe from an editable marker alone', async () => {
  mockData.set(PLATFORM_RESET_STORAGE_KEY, { nonce: 'A'.repeat(43), options: { keepEndpointOverride: false } });
  await resumeExtensionReset();
  expect(mockData.get('vault_key_password')).toBe('fixture protector');
  expect(mockWipe).not.toHaveBeenCalled();
});
it('uses the protected full request rather than altered marker fields', async () => {
  const nonce = await authorizeExtensionReset({
    keepEndpointOverride: true,
    targetNetwork: MIDEN_NETWORK_NAME.MAINNET,
    accessCode: 'fixture code'
  });
  mockData.set(PLATFORM_RESET_STORAGE_KEY, { nonce, options: { keepEndpointOverride: false } });
  await performAuthorizedExtensionReset(nonce);
  expect(mockWipe).toHaveBeenCalledWith({ keepEndpointOverride: true });
  expect(mockSteps).toEqual(['lock', 'wipe', 'network', 'code']);
  expect(mockData.has('vault_key_password')).toBe(false);
  expect(mockData.has(PLATFORM_RESET_STORAGE_KEY)).toBe(false);
});
it('refuses a different nonce without changing wallet data', async () => {
  await authorizeExtensionReset({ keepEndpointOverride: true });
  await expect(performAuthorizedExtensionReset('A'.repeat(43))).rejects.toThrow();
  expect(mockData.get('vault_key_password')).toBe('fixture protector');
});
it('recovers the authorized intent even if the page closes before writing its marker', async () => {
  await authorizeExtensionReset({ keepEndpointOverride: false });
  mockData.delete(PLATFORM_RESET_STORAGE_KEY);
  await resumeExtensionReset();
  expect(mockData.has('vault_key_password')).toBe(false);
  expect(mockWipe).toHaveBeenCalledWith({ keepEndpointOverride: false });
});
it('does not repeat a completed reset after a delayed duplicate request', async () => {
  const nonce = await authorizeExtensionReset({ keepEndpointOverride: true });
  await performAuthorizedExtensionReset(nonce);
  mockData.set('vault_key_password', 'new wallet protector');
  await performAuthorizedExtensionReset(nonce);
  expect(mockWipe).toHaveBeenCalledTimes(1);
  expect(mockData.get('vault_key_password')).toBe('new wallet protector');
});
it('keeps failed wipes pending for restart instead of permitting stale startup', async () => {
  const nonce = await authorizeExtensionReset({ keepEndpointOverride: true });
  mockWipeFailure = true;
  await expect(performAuthorizedExtensionReset(nonce)).rejects.toThrow('wipe failed');
  mockWipeFailure = false;
  await resumeExtensionReset();
  expect(mockData.has('vault_key_password')).toBe(false);
});
it('retries marker removal without wiping a later wallet', async () => {
  const nonce = await authorizeExtensionReset({ keepEndpointOverride: true });
  mockMarkerRemovalFailure = true;
  await expect(performAuthorizedExtensionReset(nonce)).rejects.toThrow('marker retained');
  mockData.set('vault_key_password', 'new wallet protector');
  mockMarkerRemovalFailure = false;
  await resumeExtensionReset();
  expect(mockWipe).toHaveBeenCalledTimes(1);
  expect(mockData.get('vault_key_password')).toBe('new wallet protector');
});
it('does not clear before an existing account-writer turn ends', async () => {
  const nonce = await authorizeExtensionReset({ keepEndpointOverride: true });
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const queue = getAccountsWriteQueue();
  const blocker = queue.add(async () => {
    await gate;
    mockSteps.push('writer');
  });
  const resetting = performAuthorizedExtensionReset(nonce);
  try {
    expect(queue.size).toBe(1);
    expect(mockSteps).toEqual([]);
    expect(mockData.get('vault_key_password')).toBe('fixture protector');
  } finally {
    release();
    await Promise.all([blocker, resetting]);
  }
  expect(mockSteps).toEqual(['writer', 'lock', 'wipe']);
});
