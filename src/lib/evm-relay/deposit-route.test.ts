import { zeroAddress } from 'viem';

import { referenceSnapshot } from 'lib/bridge/testing/fixtures';
import { selectAgglayerRecoveryConfig } from 'lib/remote-config/values';

import { relayDepositRoute } from './deposit-route';

const SEPOLIA = 11155111;
const TEST_USDC = '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69';

describe('relayDepositRoute', () => {
  it('derives the native-coin route as the Agglayer receive flow does', () => {
    const snapshot = referenceSnapshot('testnet');
    const recovery = selectAgglayerRecoveryConfig(snapshot, SEPOLIA);
    if (!recovery) throw new Error('the fixture has no Agglayer route');

    expect(relayDepositRoute(snapshot, SEPOLIA, zeroAddress)).toEqual({
      agglayerRoute: recovery,
      sourceSymbol: 'ETH',
      sourceDecimals: 18,
      outputSymbol: 'ETH',
      outputDecimals: 8,
      deposit: {
        bridgeAddress: recovery.contractAddress,
        midenNetworkId: recovery.rollupId,
        forceUpdateGlobalExitRoot: true
      }
    });
  });

  it('saves the registry delivery of an ERC-20', () => {
    const route = relayDepositRoute(referenceSnapshot('testnet'), SEPOLIA, TEST_USDC);
    expect(route?.agglayerDelivery).toEqual({
      originToken: TEST_USDC,
      faucetId: '0xb41aed8db850a3d140fc2079216c60',
      scale: 10
    });
    expect(route).toEqual(expect.objectContaining({ sourceDecimals: 18, outputDecimals: 8, sourceSymbol: 'USDC' }));
  });

  it('has no route for a token or a chain the catalog does not list', () => {
    const snapshot = referenceSnapshot('testnet');
    expect(relayDepositRoute(snapshot, SEPOLIA, '0x00000000000000000000000000000000000000aa')).toBeNull();
    expect(relayDepositRoute(snapshot, 1, zeroAddress)).toBeNull();
  });
});
