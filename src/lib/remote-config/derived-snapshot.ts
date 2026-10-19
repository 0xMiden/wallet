import { isRecord } from 'lib/update/guards';

import type { BridgeToken, DerivedBridgeConfig, DerivedChainConfig, Probe, TokenMetadata } from './derive';
import type { BridgeConfig, EvmAddress } from './schema';
import { parseSwapPairs, type SwapPairs } from './swap-pairs';
import type { EarnMarket } from './values';

/** `bridge_config_derived_v1:<network>`, holding a DerivedBridgeConfig, which records its document version. */
export function bridgeConfigDerivedKey(network: string): string {
  return `bridge_config_derived_v1:${network}`;
}

// Stored values are checked again like any other untrusted input. Derivation writes ids and addresses in lowercase,
// so these accept the lowercase form only (the wallet's general address guard is `lib/epoch/evm-address`).
const isLowercaseEvmAddress = (value: unknown): value is EvmAddress =>
  typeof value === 'string' && /^0x[0-9a-f]{40}$/.test(value);
const isMidenAccountId = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-f]{30}$/.test(value);
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const count = (value: unknown): number | null => (isCount(value) ? value : null);
const yes = (value: unknown): true | null => (value === true ? true : null);

function metadata(value: unknown): TokenMetadata | null {
  if (!isRecord(value) || typeof value.symbol !== 'string' || !isCount(value.decimals)) return null;
  return { symbol: value.symbol, decimals: value.decimals };
}

function bridgeToken(value: unknown): BridgeToken | null {
  if (!isRecord(value)) return null;
  const { midenFaucetId, originToken, originNetwork, scale } = value;
  if (
    !isMidenAccountId(midenFaucetId) ||
    !isLowercaseEvmAddress(originToken) ||
    !isCount(originNetwork) ||
    !isCount(scale)
  ) {
    return null;
  }
  return { midenFaucetId, originToken, originNetwork, scale };
}

function bridgeTokens(value: unknown): BridgeToken[] | null {
  if (!Array.isArray(value)) return null;
  const tokens = value.map(bridgeToken);
  return tokens.every((token): token is BridgeToken => token !== null) ? tokens : null;
}

function probe<T>(value: unknown, read: (value: unknown) => T | null): Probe<T> | null {
  if (!isRecord(value)) return null;
  if (value.state === 'absent') return { state: 'absent' };
  if (value.state === 'skipped') return { state: 'skipped' };
  if (value.state === 'error') {
    return typeof value.message === 'string' ? { state: 'error', message: value.message } : null;
  }
  if (value.state !== 'ok') return null;
  const found = read(value.value);
  return found === null ? null : { state: 'ok', value: found };
}

function market(value: Parameters<typeof metadata>[0]): EarnMarket | null {
  if (!isRecord(value) || typeof value.marketUid !== 'string' || !isCount(value.chainId)) return null;
  const { protocolHash, underlying } = value;
  if (typeof protocolHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(protocolHash)) return null;
  if (typeof underlying !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(underlying)) return null;
  return {
    marketUid: value.marketUid,
    underlying: `0x${underlying.slice(2)}`,
    chainId: value.chainId,
    protocolHash: `0x${protocolHash.slice(2)}`
  };
}

// The stored copy is the parser's own result, so one that loses an entry when parsed again was damaged: serving what
// survives would be a partial registry, so the document is derived again instead.
function parseStoredSwapPairs(value: unknown): SwapPairs | null {
  const parsed = parseSwapPairs(value);
  if (!parsed || !isRecord(value) || !Array.isArray(value.tokens) || !Array.isArray(value.pairs)) return null;
  return parsed.tokens.length === value.tokens.length && parsed.pairs.length === value.pairs.length ? parsed : null;
}

function chainReads(value: unknown): DerivedChainConfig | null {
  if (!isRecord(value) || !isRecord(value.agglayer) || !isRecord(value.epoch)) return null;
  const { agglayer, epoch } = value;
  const rollupId = probe(agglayer.rollupId, count);
  const tokens = probe(agglayer.tokens, bridgeTokens);
  const evmNetworkId = probe(agglayer.evmNetworkId, count);
  const l1BridgeCode = probe(agglayer.l1BridgeCode, yes);
  const evmUsdc = probe(epoch.evmUsdc, metadata);
  if (!rollupId || !tokens || !evmNetworkId || !l1BridgeCode || !evmUsdc) return null;
  return { agglayer: { rollupId, tokens, evmNetworkId, l1BridgeCode }, epoch: { evmUsdc } };
}

/**
 * The stored snapshot for `network`, or null unless it is whole and was derived from document `version`. One an
 * earlier build stored, with no chains or market, is not whole, so the document is derived again.
 */
export function parseStoredDerived(value: unknown, network: string, version: number): DerivedBridgeConfig | null {
  if (!isRecord(value) || value.network !== network || value.version !== version) return null;
  const { derivedAt, chains, agglayer, epoch } = value;
  if (
    typeof derivedAt !== 'number' ||
    !Number.isFinite(derivedAt) ||
    !isRecord(chains) ||
    !isRecord(agglayer) ||
    !isRecord(epoch)
  ) {
    return null;
  }
  const indexer = probe(agglayer.indexer, yes);
  const allocator = probe(epoch.allocator, yes);
  const earnMarket = probe(epoch.market, market);
  const midenUsdcFaucet = probe(epoch.midenUsdcFaucet, metadata);
  // A copy stored by a build that read no swap pairs has no such probe, so it reads as missing and is derived again.
  const swapPairs = isRecord(value.swap) ? probe(value.swap.pairs, parseStoredSwapPairs) : null;
  if (!indexer || !allocator || !earnMarket || !midenUsdcFaucet || !swapPairs) return null;
  const reads: Record<number, DerivedChainConfig> = {};
  for (const [key, entry] of Object.entries(chains)) {
    const chainId = Number(key);
    const parsed = chainReads(entry);
    if (!parsed || !Number.isSafeInteger(chainId) || chainId <= 0) return null;
    reads[chainId] = parsed;
  }
  return {
    network,
    version,
    derivedAt,
    chains: reads,
    agglayer: { indexer },
    epoch: { allocator, market: earnMarket, midenUsdcFaucet },
    swap: { pairs: swapPairs }
  };
}

/** Every probe failed with `message`: what a derivation that threw reads as, so the features it gates show as down. */
export function failedDerivation(config: BridgeConfig, message: string, derivedAt: number): DerivedBridgeConfig {
  const error: Probe<never> = { state: 'error', message };
  const chains: Record<number, DerivedChainConfig> = {};
  for (const { chainId } of Object.values(config.supportedEvmChains)) {
    chains[chainId] = {
      agglayer: { rollupId: error, tokens: error, evmNetworkId: error, l1BridgeCode: error },
      epoch: { evmUsdc: error }
    };
  }
  return {
    network: config.network,
    version: config.version,
    derivedAt,
    chains,
    agglayer: { indexer: error },
    epoch: { allocator: error, market: error, midenUsdcFaucet: error },
    swap: { pairs: error }
  };
}
