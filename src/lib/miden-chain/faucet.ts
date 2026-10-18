import { getEffectiveFaucetUrl, getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';

import { MIDEN_FAUCET_ENDPOINTS } from './constants';

export function getFaucetUrl(networkId: string): string | undefined {
  if (networkId === getEffectiveNetworkName()) return getEffectiveFaucetUrl();
  return MIDEN_FAUCET_ENDPOINTS.get(networkId);
}
