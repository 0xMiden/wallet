/**
 * The bridged price entries as today's testnet config names them, for the suites that price the Earn USDC or the
 * bridged ETH without loading a bridge config. Use with `jest.mock('lib/miden/swap/bridge-price-allowlist')`. A plain
 * function, so a suite's `jest.resetAllMocks()` cannot empty it.
 */
import { TEST_MIDEN_USDC_FAUCET, TEST_NATIVE_ETH_FAUCET } from 'lib/epoch/testing/bridge-config';

import type { PricedFaucet } from '../bridge-price-allowlist';

export function bridgePriceAllowlist(): PricedFaucet[] {
  return [
    { faucetId: TEST_MIDEN_USDC_FAUCET, priceSymbol: 'USDC' },
    { faucetId: TEST_NATIVE_ETH_FAUCET, priceSymbol: 'ETH' }
  ];
}
