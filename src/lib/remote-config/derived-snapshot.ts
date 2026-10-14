import { isRecord } from 'lib/update/guards';

import type { BridgeToken, DerivedBridgeConfig, DerivedChainConfig, Probe, TokenMetadata } from './derive';
import type { BridgeConfig, EvmAddress } from './schema';
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

/** The stored snapshot for `network`, or null unless it is whole and was derived from document `version`. */
export function parseStoredDerived(value: unknown, network: string, version: number): DerivedBridgeConfig | null {
  if (!isRecord(value) || value.network !== network || value.version !== version) return null;
  const { derivedAt, agglayer, epoch } = value;
  if (typeof derivedAt !== 'number' || !Number.isFinite(derivedAt) || !isRecord(agglayer) || !isRecord(epoch)) {
    return null;
  }
  const rollupId = probe(agglayer.rollupId, count);
  const tokens = probe(agglayer.tokens, bridgeTokens);
  const evmNetworkId = probe(agglayer.evmNetworkId, count);
  const l1BridgeCode = probe(agglayer.l1BridgeCode, yes);
  const indexer = probe(agglayer.indexer, yes);
  const allocator = probe(epoch.allocator, yes);
  const midenUsdcFaucet = probe(epoch.midenUsdcFaucet, metadata);
  const evmUsdc = probe(epoch.evmUsdc, metadata);
  if (
    !rollupId ||
    !tokens ||
    !evmNetworkId ||
    !l1BridgeCode ||
    !indexer ||
    !allocator ||
    !midenUsdcFaucet ||
    !evmUsdc
  ) {
    return null;
  }
  const chains: Record<number, DerivedChainConfig> = {};
  if (value.chains !== undefined) {
    if (!isRecord(value.chains)) return null;
    for (const [chainId, entry] of Object.entries(value.chains)) {
      if (!isRecord(entry)) return null;
      const parsed = parseStoredDerived(
        {
          network,
          version,
          derivedAt,
          agglayer: entry.agglayer,
          epoch: { allocator, midenUsdcFaucet, evmUsdc: isRecord(entry.epoch) ? entry.epoch.evmUsdc : null }
        },
        network,
        version
      );
      if (!parsed || !Number.isSafeInteger(Number(chainId))) return null;
      chains[Number(chainId)] = { agglayer: parsed.agglayer, epoch: { evmUsdc: parsed.epoch.evmUsdc } };
    }
  }
  const earnMarket = epoch.market === undefined ? undefined : probe(epoch.market, market);
  if (earnMarket === null) return null;
  return {
    network,
    version,
    derivedAt,
    ...(value.chains === undefined ? {} : { chains }),
    agglayer: { rollupId, tokens, evmNetworkId, l1BridgeCode, indexer },
    epoch: { allocator, midenUsdcFaucet, evmUsdc, ...(earnMarket === undefined ? {} : { market: earnMarket }) }
  };
}

/** Every probe failed with `message`: what a derivation that threw reads as, so the features it gates show as down. */
export function failedDerivation(config: BridgeConfig, message: string, derivedAt: number): DerivedBridgeConfig {
  const error: Probe<never> = { state: 'error', message };
  return {
    network: config.network,
    version: config.version,
    derivedAt,
    agglayer: { rollupId: error, tokens: error, evmNetworkId: error, l1BridgeCode: error, indexer: error },
    epoch: { allocator: error, midenUsdcFaucet: error, evmUsdc: error }
  };
}
