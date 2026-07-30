import { ensureEpochSmartAccount, resetEpochSdk } from './sdk';

const mockGetWalletGaslessStatus = jest.fn();
const mockConvertToSmartAccount = jest.fn();

jest.mock('@epoch-protocol/epoch-intents-sdk', () => ({
  EpochIntentSDK: jest.fn(() => ({
    getWalletGaslessStatus: (...args: unknown[]) => mockGetWalletGaslessStatus(...args),
    convertToSmartAccount: (...args: unknown[]) => mockConvertToSmartAccount(...args)
  }))
}));

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
