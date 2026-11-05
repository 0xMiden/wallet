import { TEST_BRIDGE_CONFIG_SNAPSHOT } from 'lib/epoch/testing/bridge-config';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { isUsdcxWithdrawalAvailable } from 'lib/usdcx/withdrawal';

import { canSendTokenToChain, sendTokenRoutes } from './send-token-routes';

jest.mock('lib/usdcx/withdrawal', () => ({ isUsdcxWithdrawalAvailable: jest.fn(() => false) }));

const ETH = '0x111111111111111111111111111111';
const USDG = '0x222222222222222222222222222222';
const USDT = '0x333333333333333333333333333333';

function robinhoodSnapshot(): BridgeConfigSnapshot {
  const { config, derived } = TEST_BRIDGE_CONFIG_SNAPSHOT;
  const reads = derived?.chains[11155111];
  if (!config || !derived || !reads) throw new Error('The test config is missing.');
  return {
    ...TEST_BRIDGE_CONFIG_SNAPSHOT,
    config: {
      ...config,
      supportedEvmChains: {
        robinhood: {
          chainId: 4663,
          bridges: {
            epoch: {
              depositEnabled: true,
              withdrawalEnabled: true,
              tokens: {
                ETH: { contractAddress: '0x0000000000000000000000000000000000000000', outputs: [] },
                USDG: { contractAddress: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', outputs: [] }
              }
            }
          }
        }
      }
    },
    derived: {
      ...derived,
      chains: {
        4663: {
          ...reads,
          epoch: {
            tokens: {
              ETH: { state: 'ok', value: { symbol: 'ETH', decimals: 18, midenFaucetId: ETH } },
              USDG: { state: 'ok', value: { symbol: 'USDG', decimals: 6, midenFaucetId: USDG } }
            }
          }
        }
      }
    }
  };
}

beforeEach(() => jest.mocked(isUsdcxWithdrawalAvailable).mockReturnValue(false));

it('allows only the resolved ETH and USDG faucets on Robinhood', () => {
  const snapshot = robinhoodSnapshot();
  expect(sendTokenRoutes(snapshot, ETH, 4663)).toEqual({ epoch: true, agglayer: false, usdcx: false });
  expect(canSendTokenToChain(snapshot, USDG, 4663)).toBe(true);
  expect(canSendTokenToChain(snapshot, USDT, 4663)).toBe(false);
  expect(canSendTokenToChain(snapshot, ETH, 137)).toBe(false);
  expect(canSendTokenToChain(snapshot, USDT)).toBe(true);
});

it('does not offer a token while its Epoch read is missing or failed', () => {
  const snapshot = robinhoodSnapshot();
  const tokens = snapshot.derived?.chains[4663]?.epoch.tokens;
  if (!tokens) throw new Error('The test reads are missing.');
  tokens.ETH = { state: 'error', message: 'RPC unavailable' };
  expect(canSendTokenToChain(snapshot, ETH, 4663)).toBe(false);
  expect(canSendTokenToChain(snapshot, USDG, 4663)).toBe(true);
});

it('checks Circle support on the selected chain', () => {
  const snapshot = robinhoodSnapshot();
  jest.mocked(isUsdcxWithdrawalAvailable).mockImplementation((_faucet, chainId) => chainId === 5042);
  expect(canSendTokenToChain(snapshot, USDT, 4663)).toBe(false);
  expect(canSendTokenToChain(snapshot, USDT, 5042)).toBe(true);
  expect(isUsdcxWithdrawalAvailable).toHaveBeenCalledWith(USDT, 4663);
});

it('keeps registered AggLayer assets available on their origin network', () => {
  const snapshot = robinhoodSnapshot();
  const chain = snapshot.config?.supportedEvmChains.robinhood;
  const reads = snapshot.derived?.chains[4663];
  if (!chain || !reads) throw new Error('The test chain is missing.');
  chain.bridges.agglayer = {
    depositEnabled: true,
    withdrawalEnabled: true,
    contractAddress: '0x0000000000000000000000000000000000000001',
    midenBridgeId: ETH,
    tokens: {}
  };
  reads.agglayer = {
    ...reads.agglayer,
    tokens: {
      state: 'ok',
      value: [
        { midenFaucetId: USDT, originToken: '0x0000000000000000000000000000000000000002', originNetwork: 0, scale: 0 }
      ]
    },
    evmNetworkId: { state: 'ok', value: 0 }
  };
  expect(sendTokenRoutes(snapshot, USDT, 4663)).toEqual({ epoch: false, agglayer: true, usdcx: false });
  reads.agglayer.evmNetworkId = { state: 'ok', value: 1 };
  expect(canSendTokenToChain(snapshot, USDT, 4663)).toBe(false);
  chain.bridges.agglayer.withdrawalEnabled = false;
  reads.agglayer.evmNetworkId = { state: 'ok', value: 0 };
  expect(canSendTokenToChain(snapshot, USDT, 4663)).toBe(false);
});
