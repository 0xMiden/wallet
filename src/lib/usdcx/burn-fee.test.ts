import type { TxAssetView } from 'app/confirm/decode';

import { estimateUsdcxBurnFeeReserve } from './burn-fee';

const NATIVE = 'mm1native';
const OTHER = 'mm1other';

const mockSimulate = jest.fn();
const mockView = jest.fn<TxAssetView | undefined, []>();
const mockBuild = jest.fn();
const mockDestination = jest.fn();

jest.mock('lib/miden/back/simulate-custom-tx', () => ({
  simulateCustomTransaction: (...args: unknown[]) => mockSimulate(...args)
}));
jest.mock('app/confirm/decode', () => ({ simulatedBytesToView: () => mockView() }));
jest.mock('lib/miden-chain/native-asset', () => ({ getNativeAssetId: async () => NATIVE }));
jest.mock('lib/remote-config/runtime', () => ({ initBridgeConfig: async () => ({}) }));
jest.mock('lib/shared/helpers', () => ({ u8ToB64: () => 'request-b64' }));
jest.mock('./burn', () => ({ buildUsdcxBurnRequest: (...args: unknown[]) => mockBuild(...args) }));
jest.mock('./constant', () => ({ getUsdcxDestination: (chainId: number) => mockDestination(chainId) }));

function view(fee: TxAssetView['fee'], outgoing: TxAssetView['outgoing']): TxAssetView {
  return { outgoing, incoming: [], inputNotesConsumed: 0, outputNotesCreated: 1, fee, storageChanged: true };
}

describe('estimateUsdcxBurnFeeReserve', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockDestination.mockReturnValue({ domain: 0 });
    mockBuild.mockReturnValue({ burnNoteId: 'note', requestBytes: new Uint8Array([1]) });
    mockSimulate.mockResolvedValue({ executedBytes: 'executed' });
  });

  it('dry-runs a one-unit burn to the destination and adds 25% headroom to the measured fee', async () => {
    mockView.mockReturnValue(view({ faucetId: NATIVE, amount: 252n }, [{ faucetId: NATIVE, amount: 1n }]));

    await expect(estimateUsdcxBurnFeeReserve('mm1sender', '0xdest', 1)).resolves.toBe(315n);
    expect(mockBuild).toHaveBeenCalledWith('mm1sender', 1n, '0xdest', 0);
    expect(mockSimulate).toHaveBeenCalledWith({ address: 'mm1sender', transactionRequest: 'request-b64' });
  });

  it('counts native outputs beyond the burned amount as cost', async () => {
    mockView.mockReturnValue(
      view({ faucetId: NATIVE, amount: 100n }, [
        { faucetId: NATIVE, amount: 1n },
        { faucetId: NATIVE, amount: 60n },
        { faucetId: OTHER, amount: 999n }
      ])
    );

    // 100 + 60 = 160, plus 40 headroom.
    await expect(estimateUsdcxBurnFeeReserve('mm1sender', '0xdest', 1)).resolves.toBe(200n);
  });

  it('rounds the headroom up', async () => {
    mockView.mockReturnValue(view({ faucetId: NATIVE, amount: 7n }, [{ faucetId: NATIVE, amount: 1n }]));

    await expect(estimateUsdcxBurnFeeReserve('mm1sender', '0xdest', 1)).resolves.toBe(9n);
  });

  it('answers null when the burn costs nothing in the native asset', async () => {
    mockView.mockReturnValue(view({ faucetId: OTHER, amount: 50n }, [{ faucetId: NATIVE, amount: 1n }]));

    await expect(estimateUsdcxBurnFeeReserve('mm1sender', '0xdest', 1)).resolves.toBeNull();
  });

  it('answers null when the dry run reports an error', async () => {
    mockSimulate.mockResolvedValue({ error: 'Simulation timed out' });

    await expect(estimateUsdcxBurnFeeReserve('mm1sender', '0xdest', 1)).resolves.toBeNull();
    expect(mockView).not.toHaveBeenCalled();
  });

  it('answers null when the dry run gives nothing to decode', async () => {
    mockView.mockReturnValue(undefined);

    await expect(estimateUsdcxBurnFeeReserve('mm1sender', '0xdest', 1)).resolves.toBeNull();
  });

  it('answers null when the destination is not configured', async () => {
    mockDestination.mockImplementation(() => {
      throw new Error('USDCx withdrawal is not configured for chain 5');
    });

    await expect(estimateUsdcxBurnFeeReserve('mm1sender', '0xdest', 5)).resolves.toBeNull();
    expect(mockSimulate).not.toHaveBeenCalled();
  });
});
