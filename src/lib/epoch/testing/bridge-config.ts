import type { MidenUsdc } from 'lib/remote-config/e2e-overrides';
import type { EarnMarket, EvmUsdc } from 'lib/remote-config/values';

/** Today's testnet Epoch deployment on fixed test hosts: the bridge-config values the Epoch suites run against. */
export const TEST_ALLOCATOR_URL = 'https://allocator.test';
export const TEST_POSITIONS_URL = 'https://positions.test';
export const TEST_EVM_CHAIN_ID = 11155111;
export const TEST_EVM_USDC: EvmUsdc = {
  address: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69',
  symbol: 'USDC',
  decimals: 18,
  chainId: TEST_EVM_CHAIN_ID
};
export const TEST_EARN_MARKET: EarnMarket = {
  marketUid: 'DUMMY_LENDING:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
  protocolHash: '0x7a2ccf6fa10307c054284131a341a8d8cbd10ec7d3cc469fbf369c40fd86d0f9',
  underlying: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69',
  chainId: TEST_EVM_CHAIN_ID
};
export const TEST_MIDEN_USDC_FAUCET = '0x537c15a622074e91188aa894456c52';
export const TEST_MIDEN_USDC: MidenUsdc = { faucetId: TEST_MIDEN_USDC_FAUCET, symbol: 'USDC', decimals: 6 };
/** The testnet bridge registry's native-ETH faucet: it mints bridged ETH and sends its deliveries. */
export const TEST_NATIVE_ETH_FAUCET = '0x0b372f2735e33e91216d995bf29b91';

/**
 * A `lib/remote-config/values` stand-in resolving to the fixtures above; every getter is a jest.fn a suite can
 * re-stub. Install it with
 * `jest.mock('lib/remote-config/values', () => jest.requireActual<typeof import('lib/epoch/testing/bridge-config')>('lib/epoch/testing/bridge-config').remoteConfigValuesMock())`.
 */
export function remoteConfigValuesMock() {
  return {
    requireEpochAllocatorUrl: jest.fn(async () => TEST_ALLOCATOR_URL),
    requireEpochPositionsUrl: jest.fn(async () => TEST_POSITIONS_URL),
    requireEvmChainId: jest.fn(async () => TEST_EVM_CHAIN_ID),
    requireEvmUsdc: jest.fn(async () => TEST_EVM_USDC),
    requireEarnMarket: jest.fn(async () => TEST_EARN_MARKET),
    requireMidenUsdc: jest.fn(async () => TEST_MIDEN_USDC)
  };
}
