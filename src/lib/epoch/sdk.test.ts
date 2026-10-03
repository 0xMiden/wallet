import { EpochIntentSDK } from '@epoch-protocol/epoch-intents-sdk';

import { getEpochAllocatorUrl } from 'lib/remote-config/values';

import { ensureEpochSmartAccount, getEpochReadOnlySdk, resetEpochSdk } from './sdk';
import { TEST_ALLOCATOR_URL } from './testing/bridge-config';

const mockGetWalletGaslessStatus = jest.fn();
const mockConvertToSmartAccount = jest.fn();

jest.mock('@epoch-protocol/epoch-intents-sdk', () => ({
  MIDEN_VIRTUAL_CHAIN_ID: 999999999,
  EpochIntentSDK: jest.fn(() => ({
    getWalletGaslessStatus: (...args: unknown[]) => mockGetWalletGaslessStatus(...args),
    convertToSmartAccount: (...args: unknown[]) => mockConvertToSmartAccount(...args)
  }))
}));
jest.mock('lib/remote-config/values', () =>
  jest.requireActual<typeof import('./testing/bridge-config')>('./testing/bridge-config').remoteConfigValuesMock()
);

jest.mock('@reown/appkit/react', () => ({ useAppKitAccount: jest.fn() }));
jest.mock('./client', () => ({
  buildEpochReadOnlyWalletClient: jest.fn(),
  buildEpochWalletClient: jest.fn(),
  getEvmConnection: jest.fn()
}));
jest.mock('./evm-account', () => ({ buildVaultEvmWalletClient: jest.fn(() => ({})) }));

const EVM_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

describe('ensureEpochSmartAccount', () => {
  beforeEach(() => {
    resetEpochSdk();
    mockGetWalletGaslessStatus.mockReset();
    mockConvertToSmartAccount.mockReset();
  });

  it('is idempotent when the Epoch delegation is already active', async () => {
    mockGetWalletGaslessStatus.mockResolvedValue({ delegation: 'epoch', canRelayDeposit: false });

    await expect(ensureEpochSmartAccount('miden-account', EVM_ADDRESS)).resolves.toBeDefined();
    expect(mockConvertToSmartAccount).not.toHaveBeenCalled();
  });

  it('converts an undelegated account and verifies the resulting delegation', async () => {
    mockGetWalletGaslessStatus
      .mockResolvedValueOnce({ delegation: 'none', canRelayDeposit: false })
      .mockResolvedValueOnce({ delegation: 'epoch', canRelayDeposit: true });
    mockConvertToSmartAccount.mockResolvedValue({ ok: true, delegation: 'epoch' });

    await expect(ensureEpochSmartAccount('miden-account', EVM_ADDRESS)).resolves.toBeDefined();
    expect(mockConvertToSmartAccount).toHaveBeenCalledWith({ chainId: 11155111 });
  });

  it('rejects a delegation owned by another smart-account implementation', async () => {
    mockGetWalletGaslessStatus.mockResolvedValue({ delegation: 'other', canRelayDeposit: false });

    await expect(ensureEpochSmartAccount('miden-account', EVM_ADDRESS)).rejects.toThrow(
      'unsupported smart-account implementation'
    );
  });

  it('surfaces a failed relay setup', async () => {
    mockGetWalletGaslessStatus.mockResolvedValue({ delegation: 'none', canRelayDeposit: false });
    mockConvertToSmartAccount.mockResolvedValue({ ok: false, reason: 'relay unavailable' });

    await expect(ensureEpochSmartAccount('miden-account', EVM_ADDRESS)).rejects.toThrow('relay unavailable');
  });

  it('rejects when setup returns before the delegation becomes active', async () => {
    mockGetWalletGaslessStatus.mockResolvedValue({ delegation: 'none', canRelayDeposit: false });
    mockConvertToSmartAccount.mockResolvedValue({ ok: true, delegation: 'epoch' });

    await expect(ensureEpochSmartAccount('miden-account', EVM_ADDRESS)).rejects.toThrow('delegation is not active');
  });
});

describe('the configured allocator', () => {
  beforeEach(() => {
    resetEpochSdk();
    jest.mocked(EpochIntentSDK).mockClear();
    jest.mocked(getEpochAllocatorUrl).mockReturnValue(TEST_ALLOCATOR_URL);
  });

  const allocators = () => jest.mocked(EpochIntentSDK).mock.calls.map(([config]) => config.apiBaseUrl);

  it('builds an SDK against the allocator the config names, and reuses it while that stays', async () => {
    const first = await getEpochReadOnlySdk(EVM_ADDRESS);
    expect(await getEpochReadOnlySdk(EVM_ADDRESS)).toBe(first);
    expect(allocators()).toEqual([TEST_ALLOCATOR_URL]);
  });

  it('rebuilds the SDK against the new host once the config moves the allocator', async () => {
    const first = await getEpochReadOnlySdk(EVM_ADDRESS);
    jest.mocked(getEpochAllocatorUrl).mockReturnValue('https://moved.test');
    expect(await getEpochReadOnlySdk(EVM_ADDRESS)).not.toBe(first);
    expect(allocators()).toEqual([TEST_ALLOCATOR_URL, 'https://moved.test']);
  });

  it('builds nothing while the config names no allocator', async () => {
    jest.mocked(getEpochAllocatorUrl).mockImplementation(() => {
      throw new Error('no allocator');
    });
    await expect(getEpochReadOnlySdk(EVM_ADDRESS)).rejects.toThrow('no allocator');
    await expect(ensureEpochSmartAccount('miden-account', EVM_ADDRESS)).rejects.toThrow('no allocator');
    expect(EpochIntentSDK).not.toHaveBeenCalled();
  });
});
