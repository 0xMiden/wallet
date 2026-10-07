import { getTestNetworkNameKey } from 'lib/miden-chain/effective-endpoints';

import { normalizedFaucetId, TOKEN_IETH } from './tokens';

/** The copy a swap token's info sheet and token page show: what the token is, and where its swaps execute. */
export interface SwapTokenInfo {
  descriptionKey: 'testIethDescription';
  executionKey: 'testIethExecution';
}

const TEST_IETH_INFO: SwapTokenInfo = { descriptionKey: 'testIethDescription', executionKey: 'testIethExecution' };

/** Testnet's iETH, matched by canonical faucet id, never by the symbol a faucet gives itself (#1131); else null. */
export function swapTokenInfo(faucetId: string | undefined): SwapTokenInfo | null {
  if (!faucetId || getTestNetworkNameKey() !== 'testnet') return null;
  return normalizedFaucetId(faucetId) === normalizedFaucetId(TOKEN_IETH.faucetId) ? TEST_IETH_INFO : null;
}
