import { priceSymbolFor } from 'lib/miden/swap/tokens';
import { getBridgeConfigSnapshot, type BridgeConfigSnapshot } from 'lib/remote-config/runtime';

import { quotedPrice, type TokenPrices } from './binance';

/** Resolve an EVM asset by its configured chain and contract, never its claimed ticker. */
export function evmPriceSymbolFor(
  chainId: number | undefined,
  address: string | undefined,
  snapshot: BridgeConfigSnapshot = getBridgeConfigSnapshot()
): string | undefined {
  if (chainId === undefined || address === undefined) return undefined;
  const contract = address.toLowerCase();
  const chain = Object.values(snapshot.config?.supportedEvmChains ?? {}).find(entry => entry.chainId === chainId);
  if (!chain) return undefined;
  const circle = chain.bridges.usdcx?.tokens.USDC?.contractAddress;
  if (circle && circle.toLowerCase() === contract) return 'USDC';
  // An Epoch token is priced as the Miden token it settles into; the route's USDC is USDC whatever it names.
  const epoch = Object.entries(chain.bridges.epoch?.tokens ?? {}).find(
    ([, token]) => token.contractAddress.toLowerCase() === contract
  );
  if (epoch) {
    const [key] = epoch;
    if (key === 'USDC') return 'USDC';
    const read = snapshot.derived?.chains[chainId]?.epoch.tokens[key];
    const faucetId = read?.state === 'ok' ? read.value.midenFaucetId : undefined;
    return faucetId === undefined ? undefined : priceSymbolFor(faucetId, '');
  }
  const reads = snapshot.derived?.chains[chainId]?.agglayer;
  const tokens = reads?.tokens;
  if (tokens?.state !== 'ok') return undefined;
  const networkId =
    contract === '0x0000000000000000000000000000000000000000'
      ? 0
      : reads?.evmNetworkId?.state === 'ok'
        ? reads.evmNetworkId.value
        : undefined;
  if (networkId === undefined) return undefined;
  const token = tokens.value.find(
    entry => entry.originToken.toLowerCase() === contract && entry.originNetwork === networkId
  );
  return token ? priceSymbolFor(token.midenFaucetId, '') : undefined;
}

export function evmQuote(
  prices: TokenPrices,
  chainId: number | undefined,
  address: string | undefined,
  snapshot: BridgeConfigSnapshot = getBridgeConfigSnapshot()
) {
  return quotedPrice(prices, evmPriceSymbolFor(chainId, address, snapshot));
}
