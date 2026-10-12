import { getBridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { selectMidenUsdcFaucetId, selectNativeEthFaucet } from 'lib/remote-config/values';

export interface PricedFaucet {
  faucetId: string;
  priceSymbol: string;
}

/**
 * The bridged faucets the wallet prices, from the bridge config this realm has loaded: the Earn collateral at USDC
 * and the registry's native-ETH faucet at ETH. Before the first load, or for a value the config cannot name, an entry
 * is missing and that faucet is unpriced like any unknown token.
 */
export function bridgePriceAllowlist(): PricedFaucet[] {
  const snapshot = getBridgeConfigSnapshot();
  const entries = [
    { faucetId: selectMidenUsdcFaucetId(snapshot), priceSymbol: 'USDC' },
    { faucetId: selectNativeEthFaucet(snapshot), priceSymbol: 'ETH' }
  ];
  return entries.flatMap(({ faucetId, priceSymbol }) => (faucetId ? [{ faucetId, priceSymbol }] : []));
}
