import { DEFAULT_NETWORK, MIDEN_FAUCET_ENDPOINTS } from './constants';

export function getFaucetUrl(networkId: string): string {
  return MIDEN_FAUCET_ENDPOINTS.get(networkId) ?? MIDEN_FAUCET_ENDPOINTS.get(DEFAULT_NETWORK)!;
}
