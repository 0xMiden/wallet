// Adapted from bridge-portal@cb52c470 src/bridge/providers/agglayer/quote.ts (MIT).
import { createPublicClient, formatUnits, http, parseAbi, parseUnits } from 'viem';

import { isBridgeRouteAvailable } from 'lib/bridge/core/provider';
import type { QuoteRequest, QuoteResult } from 'lib/bridge/core/quote';
import { configKey, routeMatchesRecovery } from 'lib/bridge/core/routes';
import { validateTransferAmount } from 'lib/bridge/core/rules';
import { getBridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { selectAgglayerRecoveryConfig } from 'lib/remote-config/values';
import { EVM_CHAIN_DEFINITIONS, getChain } from 'lib/walletconnect/config';

const statusAbi = parseAbi(['function isEmergencyState() view returns (bool)']);

/** Same asset, exact payout; gas is separate. A failed live read supplies no quote. */
export async function quoteAgglayer(request: QuoteRequest, signal: AbortSignal): Promise<QuoteResult | null> {
  const { route, amount } = structuredClone(request);
  validateTransferAmount(route, amount);
  signal.throwIfAborted();
  const network = route.mode === 'receive' ? route.source.network : route.destination.network;
  const chainId = route.recovery.config.supportedEvmChains[network]?.chainId;
  const recovery = chainId && selectAgglayerRecoveryConfig({ ...route.recovery, status: 'ready', lastFetch: null }, chainId);
  const chain = EVM_CHAIN_DEFINITIONS.find(item => item.id === chainId);
  const rpc = chainId && getChain(chainId);
  const assertCurrent = () => {
    const current = getBridgeConfigSnapshot();
    if (route.provider !== 'agglayer' || !isBridgeRouteAvailable(route) || !routeMatchesRecovery(route) || current.status !== 'ready' || configKey([current.network, current.config, current.derived]) !== configKey([route.recovery.network, route.recovery.config, route.recovery.derived]))
      throw new Error('Agglayer quote terms changed');
    signal.throwIfAborted();
  };
  assertCurrent();
  if (!recovery || !chain || !rpc) throw new Error('Agglayer route unavailable');
  const client = createPublicClient({ chain, transport: http(rpc.rpcUrl, { timeout: 10000, retryCount: 0 }) });
  const paused = await client.readContract({ address: recovery.contractAddress, abi: statusAbi, functionName: 'isEmergencyState' });
  assertCurrent();
  if (paused) throw new Error('Agglayer is paused');
  return { kind: 'agglayer', received: formatUnits(parseUnits(amount.trim(), route.destination.decimals), route.destination.decimals), validity: { kind: 'time', expiresAt: Date.now() + 60000 } };
}
