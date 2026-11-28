/**
 * The wallet's own USD price of a relay fee token. The relay service gives no value here: the wallet checks the fee
 * of a quote against its USD fee limit with this price.
 */
import type { Address } from 'viem';

import { evmPriceSymbolFor } from 'lib/prices/evm';
import { getPriceMicro } from 'lib/prices/usd';

/**
 * The price of one whole `token` on `chainId` in micro-dollars, from the wallet's price feed (Binance, then Kraken).
 * The zero address is the native coin. The token is found by its chain and contract in the wallet config, never by a
 * symbol that it claims. Undefined when the config does not name the token, or when no fresh price is available.
 */
export async function relayFeeTokenPriceMicroUsd(chainId: number, token: Address): Promise<bigint | undefined> {
  const symbol = evmPriceSymbolFor(chainId, token);
  return symbol === undefined ? undefined : getPriceMicro(symbol);
}
