import { getAddress } from 'viem';

import { earnLenderFamily, type EarnVaultInfo } from 'lib/epoch/pools-read';
import { isRecord } from 'lib/update/guards';

import type {
  AgglayerDepositToken,
  BridgeToken,
  DerivedBridgeConfig,
  DerivedChainConfig,
  EpochTokenRead,
  Probe,
  TokenMetadata
} from './derive';
import {
  type BridgeConfig,
  EARN_VAULT_LOGO,
  EARN_VAULT_PROTOCOLS,
  EARN_VAULT_RISKS,
  type EarnVaultConfig,
  type EvmAddress,
  MAX_EARN_VAULT_ABOUT_LENGTH,
  MAX_EARN_VAULT_NAME_LENGTH
} from './schema';
import { parseSwapPairs, type SwapPairs } from './swap-pairs';
import type { EarnMarket } from './values';

/** `bridge_config_derived_v2:<network>`, holding a DerivedBridgeConfig, which records its document version. */
export function bridgeConfigDerivedKey(network: string): string {
  return `bridge_config_derived_v2:${network}`;
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

// A symbol the derivation stored: the document's key, checked again as any other stored text.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const isTokenSymbol = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 32 && !CONTROL_CHARACTER.test(value);

function depositToken(value: unknown): AgglayerDepositToken | null {
  if (!isRecord(value)) return null;
  const { symbol, contractAddress, decimals, midenFaucetId, scale } = value;
  if (
    !isTokenSymbol(symbol) ||
    !isLowercaseEvmAddress(contractAddress) ||
    !isCount(decimals) ||
    !isMidenAccountId(midenFaucetId) ||
    !isCount(scale)
  ) {
    return null;
  }
  return { symbol, contractAddress, decimals, midenFaucetId, scale };
}

function depositTokens(value: unknown): AgglayerDepositToken[] | null {
  if (!Array.isArray(value)) return null;
  const tokens = value.map(depositToken);
  return tokens.every((token): token is AgglayerDepositToken => token !== null) ? tokens : null;
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

const isString = (value: unknown): value is string => typeof value === 'string';
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const CHAIN_ID = /^[1-9][0-9]*$/;
const EARN_VAULT_ID = /^[a-z][a-z0-9-]*$/;
const EARN_MARKET_UID = /^[a-z0-9_]+:[1-9][0-9]*:0x[0-9a-f]{40}$/;
const CHECKSUM_EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The value of an optional key: undefined when it is absent, `false` when it holds a value `check` refuses. */
function optional<T>(
  record: Record<string, unknown>,
  key: string,
  check: (value: unknown) => value is T
): T | undefined | false {
  const value = record[key];
  if (value === undefined) return undefined;
  return check(value) ? value : false;
}

function earnText(value: unknown, maxLength: number): value is string {
  return isString(value) && value.length > 0 && value.length <= maxLength;
}

// The document's entry as the parser kept it (`readEarnVault` in schema.ts). The stored snapshot is bound to the
// document version, so the same rules hold for it.
function earnListing(value: unknown): EarnVaultConfig | null {
  if (!isRecord(value)) return null;
  const { id, marketUid, name, protocol, about, risk, depositsEnabled, logo } = value;
  const knownProtocol = EARN_VAULT_PROTOCOLS.find(known => known === protocol);
  const knownRisk = EARN_VAULT_RISKS.find(known => known === risk);
  if (
    !isString(id) ||
    !EARN_VAULT_ID.test(id) ||
    !isString(marketUid) ||
    !EARN_MARKET_UID.test(marketUid) ||
    !earnText(name, MAX_EARN_VAULT_NAME_LENGTH) ||
    knownProtocol === undefined ||
    (about !== undefined && !earnText(about, MAX_EARN_VAULT_ABOUT_LENGTH)) ||
    (risk !== undefined && knownRisk === undefined) ||
    typeof depositsEnabled !== 'boolean' ||
    (logo !== undefined && !(isString(logo) && EARN_VAULT_LOGO.test(logo)))
  ) {
    return null;
  }
  return {
    id,
    marketUid,
    name,
    protocol: knownProtocol,
    ...(isString(about) ? { about } : {}),
    ...(knownRisk === undefined ? {} : { risk: knownRisk }),
    depositsEnabled,
    ...(isString(logo) ? { logo } : {})
  };
}

function earnRisk(value: unknown): value is { score: number; label: string } {
  return isRecord(value) && isFiniteNumber(value.score) && isString(value.label);
}

// A vault as `readEarnVaults` (lib/epoch/pools-read.ts) builds it. The uid must name the vault's own lender, chain and
// token and the listing's market, since a deposit names it; the lender family is the one its lender key gives.
function earnVault(value: unknown): EarnVaultInfo | null {
  if (!isRecord(value)) return null;
  const { marketUid, lenderKey, lenderFamily, lenderName, marketName, logoUri, chainId, underlying } = value;
  const { depositApr, aprTotal, canOpen } = value;
  const listing = earnListing(value.listing);
  if (
    !listing ||
    !isString(marketUid) ||
    !isString(lenderKey) ||
    lenderKey.length === 0 ||
    !isString(lenderName) ||
    !isString(marketName) ||
    !isString(logoUri) ||
    !isString(chainId) ||
    !CHAIN_ID.test(chainId) ||
    !isRecord(underlying) ||
    !isFiniteNumber(depositApr) ||
    !isFiniteNumber(aprTotal) ||
    typeof canOpen !== 'boolean'
  ) {
    return null;
  }
  const { address, symbol, decimals } = underlying;
  if (
    !isString(address) ||
    !CHECKSUM_EVM_ADDRESS.test(address) ||
    getAddress(address) !== address ||
    !isString(symbol) ||
    !isCount(decimals) ||
    decimals > 255
  ) {
    return null;
  }
  if (
    marketUid !== `${lenderKey}:${chainId}:${address.toLowerCase()}` ||
    marketUid.toLowerCase() !== listing.marketUid
  ) {
    return null;
  }
  const family = earnLenderFamily(lenderKey);
  if (lenderFamily !== family) return null;
  const totalDepositsUsd = optional(value, 'totalDepositsUsd', isFiniteNumber);
  const totalLiquidityUsd = optional(value, 'totalLiquidityUsd', isFiniteNumber);
  const utilization = optional(value, 'utilization', isFiniteNumber);
  const risk = optional(value, 'risk', earnRisk);
  const about = optional(value, 'about', isString);
  if (
    totalDepositsUsd === false ||
    totalLiquidityUsd === false ||
    utilization === false ||
    risk === false ||
    about === false
  ) {
    return null;
  }
  return {
    marketUid,
    lenderKey,
    ...(family === undefined ? {} : { lenderFamily: family }),
    lenderName,
    marketName,
    logoUri,
    chainId,
    underlying: { address: getAddress(address), symbol, decimals },
    depositApr,
    aprTotal,
    ...(totalDepositsUsd === undefined ? {} : { totalDepositsUsd }),
    ...(totalLiquidityUsd === undefined ? {} : { totalLiquidityUsd }),
    ...(utilization === undefined ? {} : { utilization }),
    ...(risk === undefined ? {} : { risk: { score: risk.score, label: risk.label } }),
    canOpen,
    ...(about === undefined ? {} : { about }),
    listing
  };
}

// One vault that does not read back makes the whole list unreadable: a partial catalogue would hide a listed vault.
function earnVaults(value: unknown): EarnVaultInfo[] | null {
  if (!Array.isArray(value)) return null;
  const vaults = value.map(earnVault);
  return vaults.every((vault): vault is EarnVaultInfo => vault !== null) ? vaults : null;
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
  // A copy stored by a build that read no deposit tokens has no such probe, so it reads as missing and is derived again.
  const deposits = probe(agglayer.depositTokens, depositTokens);
  // A copy stored by a build that read only the route's USDC has no token map, so it reads as missing and is derived
  // again.
  const epochTokens = epochTokenReads(epoch.tokens);
  if (!rollupId || !tokens || !evmNetworkId || !l1BridgeCode || !deposits || !epochTokens) return null;
  return {
    agglayer: { rollupId, tokens, evmNetworkId, l1BridgeCode, depositTokens: deposits },
    epoch: { tokens: epochTokens }
  };
}

// An Epoch token's read: its contract's metadata, and the faucet it settles into when the derivation resolved one.
function epochTokenRead(value: unknown): EpochTokenRead | null {
  const read = metadata(value);
  if (!read || !isRecord(value) || value.midenFaucetId === undefined) return read;
  return isMidenAccountId(value.midenFaucetId) ? { ...read, midenFaucetId: value.midenFaucetId } : null;
}

// One token read that does not read back makes the whole map unreadable, as a partial list would hide a token.
function epochTokenReads(value: unknown): Record<string, Probe<EpochTokenRead>> | null {
  if (!isRecord(value)) return null;
  const reads: Record<string, Probe<EpochTokenRead>> = {};
  for (const [symbol, read] of Object.entries(value)) {
    const parsed = probe(read, epochTokenRead);
    if (!parsed) return null;
    reads[symbol] = parsed;
  }
  return reads;
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
  // Likewise a copy stored by a build that kept no vault catalogue. A catalogue that is stored but does not read back
  // is a failed read, not a partial list: the copy stays in use, and the failed read keeps the poll at its degraded
  // pace (`unavailableReasons` in runtime.ts), so a bad copy is replaced on the next check, not derived again in a loop.
  const vaults: Probe<EarnVaultInfo[]> | null =
    epoch.vaults === undefined
      ? null
      : (probe(epoch.vaults, earnVaults) ?? {
          state: 'error',
          message: 'The stored Earn vault catalogue is malformed'
        });
  if (!indexer || !allocator || !earnMarket || !midenUsdcFaucet || !swapPairs || !vaults) return null;
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
    epoch: { allocator, market: earnMarket, midenUsdcFaucet, vaults },
    swap: { pairs: swapPairs }
  };
}

/** Every probe failed with `message`: what a derivation that threw reads as, so the features it gates show as down. */
export function failedDerivation(config: BridgeConfig, message: string, derivedAt: number): DerivedBridgeConfig {
  const error: Probe<never> = { state: 'error', message };
  const chains: Record<number, DerivedChainConfig> = {};
  for (const { chainId, bridges } of Object.values(config.supportedEvmChains)) {
    chains[chainId] = {
      agglayer: { rollupId: error, tokens: error, evmNetworkId: error, l1BridgeCode: error, depositTokens: error },
      epoch: { tokens: Object.fromEntries(Object.keys(bridges.epoch?.tokens ?? {}).map(symbol => [symbol, error])) }
    };
  }
  return {
    network: config.network,
    version: config.version,
    derivedAt,
    chains,
    agglayer: { indexer: error },
    epoch: { allocator: error, market: error, midenUsdcFaucet: error, vaults: error },
    swap: { pairs: error }
  };
}
