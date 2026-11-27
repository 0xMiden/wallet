import type { EndpointOverride } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { WalletMessageType } from 'lib/shared/types';

import { prepareMainnet, revertMainnetOverride, waitForMainnetPreparation } from './prepare-mainnet';

let mockEffectiveNetwork = MIDEN_NETWORK_NAME.TESTNET;
let mockIsExtension = true;

const mockRequest = jest.fn<Promise<void>, [unknown]>(async () => {});
const mockApplyEndpointOverride = jest.fn<Promise<void>, [EndpointOverride]>(async override => {
  mockEffectiveNetwork = override.networkName;
});
const mockClearEndpointOverride = jest.fn<Promise<void>, []>(async () => {
  mockEffectiveNetwork = MIDEN_NETWORK_NAME.TESTNET;
});
const mockFollowEffectiveNetwork = jest.fn();
const mockResetMidenClient = jest.fn<Promise<void>, []>(async () => {});

jest.mock('lib/miden/front', () => ({
  request: (payload: unknown) => mockRequest(payload)
}));

jest.mock('lib/miden-chain/effective-endpoints', () => {
  const actual = jest.requireActual('lib/miden-chain/effective-endpoints');
  return {
    ...actual,
    applyEndpointOverride: (override: EndpointOverride) => mockApplyEndpointOverride(override),
    clearEndpointOverride: () => mockClearEndpointOverride(),
    getEffectiveNetworkName: () => mockEffectiveNetwork
  };
});

jest.mock('lib/platform', () => ({
  isExtension: () => mockIsExtension
}));

jest.mock('lib/remote-config/runtime', () => ({
  followEffectiveNetwork: () => mockFollowEffectiveNetwork()
}));

jest.mock('lib/miden/sdk/miden-client', () => ({
  resetMidenClient: () => mockResetMidenClient()
}));

describe('prepare-mainnet', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEffectiveNetwork = MIDEN_NETWORK_NAME.TESTNET;
    mockIsExtension = true;
    mockRequest.mockReset().mockResolvedValue(undefined);
    mockApplyEndpointOverride.mockReset().mockImplementation(async override => {
      mockEffectiveNetwork = override.networkName;
    });
    mockClearEndpointOverride.mockReset().mockImplementation(async () => {
      mockEffectiveNetwork = MIDEN_NETWORK_NAME.TESTNET;
    });
    mockFollowEffectiveNetwork.mockReset();
    mockResetMidenClient.mockReset().mockResolvedValue(undefined);
  });

  it('is a no-op when already on mainnet and no refresh is owed', async () => {
    mockEffectiveNetwork = MIDEN_NETWORK_NAME.MAINNET;

    await prepareMainnet();

    expect(mockApplyEndpointOverride).not.toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockResetMidenClient).not.toHaveBeenCalled();
    expect(mockFollowEffectiveNetwork).not.toHaveBeenCalled();
  });

  it('switches to mainnet and reloads extension endpoint overrides, clearing refreshOwed after success', async () => {
    await prepareMainnet();

    expect(mockApplyEndpointOverride).toHaveBeenCalledWith(
      expect.objectContaining({ networkName: MIDEN_NETWORK_NAME.MAINNET, rpcUrl: '' })
    );
    expect(mockRequest).toHaveBeenCalledWith({ type: WalletMessageType.ReloadEndpointOverridesRequest });
    expect(mockResetMidenClient).not.toHaveBeenCalled();
    expect(mockFollowEffectiveNetwork).toHaveBeenCalledTimes(1);
    expect(mockApplyEndpointOverride.mock.invocationCallOrder[0]!).toBeLessThan(
      mockRequest.mock.invocationCallOrder[0]!
    );
    expect(mockRequest.mock.invocationCallOrder[0]!).toBeLessThan(
      mockFollowEffectiveNetwork.mock.invocationCallOrder[0]!
    );

    await prepareMainnet();
    expect(mockApplyEndpointOverride).toHaveBeenCalledTimes(1);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('resets MidenClient and follows effective network on non-extension platforms', async () => {
    mockIsExtension = false;

    await prepareMainnet();

    expect(mockApplyEndpointOverride).toHaveBeenCalledWith(
      expect.objectContaining({ networkName: MIDEN_NETWORK_NAME.MAINNET })
    );
    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockResetMidenClient).toHaveBeenCalledTimes(1);
    expect(mockFollowEffectiveNetwork).toHaveBeenCalledTimes(1);
    expect(mockResetMidenClient.mock.invocationCallOrder[0]!).toBeLessThan(
      mockFollowEffectiveNetwork.mock.invocationCallOrder[0]!
    );
  });

  it('keeps refreshOwed set if realm refresh fails so retry refreshes without re-applying override', async () => {
    mockRequest.mockRejectedValueOnce(new Error('SW asleep'));

    await expect(prepareMainnet()).rejects.toThrow('SW asleep');
    expect(mockFollowEffectiveNetwork).not.toHaveBeenCalled();

    await prepareMainnet();
    expect(mockApplyEndpointOverride).toHaveBeenCalledTimes(1);
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(mockFollowEffectiveNetwork).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent prepareMainnet calls and waitForMainnetPreparation waits for completion', async () => {
    await waitForMainnetPreparation();

    let releaseRequest!: () => void;
    mockRequest.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          releaseRequest = resolve;
        })
    );

    const first = prepareMainnet();
    const second = prepareMainnet();
    const waiter = waitForMainnetPreparation();
    expect(second).toBe(first);

    await Promise.resolve();
    releaseRequest();
    await Promise.all([first, second, waiter]);
    expect(mockApplyEndpointOverride).toHaveBeenCalledTimes(1);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('revertMainnetOverride restores a previous override and refreshes the extension realm', async () => {
    const previousOverride = {
      rpcUrl: 'https://custom-testnet.example',
      proverUrl: '',
      noteTransportUrl: '',
      faucetUrl: '',
      faucetApiUrl: '',
      explorerUrl: '',
      guardianUrl: '',
      allowNoGuardian: false,
      networkName: MIDEN_NETWORK_NAME.TESTNET,
      presetName: 'custom'
    };
    mockEffectiveNetwork = MIDEN_NETWORK_NAME.MAINNET;

    await revertMainnetOverride(previousOverride);

    expect(mockClearEndpointOverride).not.toHaveBeenCalled();
    expect(mockApplyEndpointOverride).toHaveBeenCalledWith(previousOverride);
    expect(mockRequest).toHaveBeenCalledWith({ type: WalletMessageType.ReloadEndpointOverridesRequest });
    expect(mockFollowEffectiveNetwork).toHaveBeenCalledTimes(1);
    expect(mockEffectiveNetwork).toBe(MIDEN_NETWORK_NAME.TESTNET);
  });

  it('revertMainnetOverride(null) clears override and resets MidenClient + follows network off extension', async () => {
    mockIsExtension = false;
    await prepareMainnet();
    jest.clearAllMocks();

    await revertMainnetOverride(null);

    expect(mockClearEndpointOverride).toHaveBeenCalledTimes(1);
    expect(mockApplyEndpointOverride).not.toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockResetMidenClient).toHaveBeenCalledTimes(1);
    expect(mockFollowEffectiveNetwork).toHaveBeenCalledTimes(1);
    expect(mockClearEndpointOverride.mock.invocationCallOrder[0]!).toBeLessThan(
      mockResetMidenClient.mock.invocationCallOrder[0]!
    );
    expect(mockResetMidenClient.mock.invocationCallOrder[0]!).toBeLessThan(
      mockFollowEffectiveNetwork.mock.invocationCallOrder[0]!
    );
    expect(mockEffectiveNetwork).toBe(MIDEN_NETWORK_NAME.TESTNET);
  });

  it('revertMainnetOverride keeps refreshOwed set if realm refresh fails so a later prepareMainnet refreshes', async () => {
    mockIsExtension = false;
    mockEffectiveNetwork = MIDEN_NETWORK_NAME.MAINNET;
    mockResetMidenClient.mockRejectedValueOnce(new Error('client reset failed'));

    await expect(
      revertMainnetOverride({
        rpcUrl: '',
        proverUrl: '',
        noteTransportUrl: '',
        faucetUrl: '',
        faucetApiUrl: '',
        explorerUrl: '',
        guardianUrl: '',
        allowNoGuardian: false,
        networkName: MIDEN_NETWORK_NAME.MAINNET,
        presetName: 'mainnet'
      })
    ).rejects.toThrow('client reset failed');
    expect(mockFollowEffectiveNetwork).not.toHaveBeenCalled();

    await prepareMainnet();
    expect(mockResetMidenClient).toHaveBeenCalledTimes(2);
    expect(mockFollowEffectiveNetwork).toHaveBeenCalledTimes(1);
  });
});
