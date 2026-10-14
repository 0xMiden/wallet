import { KNOWN_SYMBOLS } from 'lib/prices/constant';
import { isRecord } from 'lib/update/guards';
import { SUPPORTED_CHAINS } from 'lib/walletconnect/config';

import { evmChainSlug } from './chains';

/** The per-feature switches a document carries; each stops new starts only. */
export const BRIDGE_SWITCHES: readonly BridgeSwitch[] = ['earn'];
export type BridgeSwitch = 'earn';

/** The marks `components/TokenLogo` ships, which a swap token's `logo` names. */
export const SUPPORTED_SWAP_TOKEN_LOGOS = ['MIDEN', 'ETH', 'USDC', 'BTC'] as const;
export type SwapTokenLogo = (typeof SUPPORTED_SWAP_TOKEN_LOGOS)[number];

/** A fungible faucet's decimals: the protocol allows up to 12 (miden-objects `BasicFungibleFaucet::MAX_DECIMALS`). */
export const MAX_SWAP_TOKEN_DECIMALS = 12;

/** A swap token as the document lists it. */
export interface SwapTokenConfig {
  /** 1 to 6 upper-case letters, as the protocol's `TokenSymbol` allows; unique in the list. */
  symbol: string;
  /** '0x' + 30 lowercase hex; unique in the list. */
  faucetId: string;
  /** The faucet's on-chain decimals: typed amounts are converted with it. */
  decimals: number;
  logo?: SwapTokenLogo;
  /** The asset the price feed values the token at (a `KNOWN_SYMBOLS` key); absent means unpriced. */
  priceSymbol?: string;
}

export interface SwapConfig {
  /** In picker order; the first two are the pair the swap form opens on. */
  tokens: SwapTokenConfig[];
  /** The DEX quote service's base URL, which `getSwapEta` appends `/v1/swap-eta` to; absent means no quotes. */
  etaUrl?: string;
}

/** EVM chains the wallet ships RPC and explorer definitions for: the WalletConnect chain registry (Sepolia). */
export const SUPPORTED_EVM_CHAIN_IDS: readonly number[] = SUPPORTED_CHAINS.map(chain => chain.id);

/** Earn protocols the Earn code supports. */
export const SUPPORTED_EARN_PROTOCOLS = ['dummy-lending'] as const;
export type EarnProtocol = (typeof SUPPORTED_EARN_PROTOCOLS)[number];

/** A 20-byte EVM address, lowercase. */
export type EvmAddress = `0x${string}`;

/** The switch and moment behind the mainnet countdown banner. `launchAt` is epoch milliseconds, UTC. */
export interface MainnetCountdownConfig {
  enabled: boolean;
  launchAt?: number;
}

export interface RouteSwitches {
  depositEnabled: boolean;
  withdrawalEnabled: boolean;
}

export interface EpochChainConfig extends RouteSwitches {
  tokens: { USDC?: { contractAddress: EvmAddress; outputs: string[] } };
}

export interface AgglayerChainConfig extends RouteSwitches {
  contractAddress: EvmAddress;
  midenBridgeId: string;
}

export type UsdcxDepositConfig =
  | { route: 'xreserve'; xReserve: EvmAddress }
  | { route: 'executor'; executorChain: string; tokenMessenger: EvmAddress; tokenMessengerWithFees: EvmAddress };

export interface UsdcxChainConfig extends RouteSwitches {
  domain: number;
  tokens: { USDC?: { contractAddress: EvmAddress } };
  deposit?: UsdcxDepositConfig;
  executor?: { address: EvmAddress; handler: EvmAddress };
}

export interface SupportedEvmChainConfig {
  chainId: number;
  bridges: { epoch?: EpochChainConfig; agglayer?: AgglayerChainConfig; usdcx?: UsdcxChainConfig };
}

export interface AgglayerRecoveryConfig {
  chainId: number;
  contractAddress: EvmAddress;
  midenBridgeId: string;
  indexerUrl: string;
  rollupId: number;
  evmNetworkId: number;
}

export interface BridgeProviders {
  epoch: {
    allocatorUrl?: string;
    positionsUrl?: string;
    outputs?: Record<string, { faucetId: string }>;
  };
  agglayer: { indexerUrl?: string };
  usdcx: { midenDomain?: number; attestationUrl?: string; irisUrl?: string };
}

export interface BridgeConfig {
  network: string;
  version: number;
  'bridge-providers': BridgeProviders;
  supportedEvmChains: Record<string, SupportedEvmChainConfig>;
  features: { earn: boolean };
  mainnetCountdown?: MainnetCountdownConfig;
  swap?: SwapConfig;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MIDEN_ACCOUNT_ID = /^0x[0-9a-fA-F]{30}$/;
const TOKEN_SYMBOL = /^[A-Z]{1,6}$/;
// An RFC 3339 timestamp in UTC, such as 2026-10-26T00:00:00Z: one spelling, so every wallet reads the same instant.
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const LOCAL_HTTP_HOSTS = ['127.0.0.1', 'localhost'];

// Each check throws on a violation and parseBridgeConfig catches once: one bad known field rejects the document.
// The one exception is mainnetCountdown, which only drives a banner: a bad countdown turns it off (see readCountdown).
const invalid = (): never => {
  throw new Error('invalid bridge config');
};

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

// Absent means undefined only: JSON has no undefined, and a null is a value of the wrong type.
function read<T>(section: Record<string, unknown>, key: string, check: (value: unknown) => T): T | undefined {
  const value = section[key];
  return value === undefined ? undefined : check(value);
}

function section(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  return isRecord(value) ? value : invalid();
}

function evmAddress(value: unknown): EvmAddress {
  if (typeof value !== 'string' || !EVM_ADDRESS.test(value)) return invalid();
  return `0x${value.slice(2).toLowerCase()}`;
}

function midenAccountId(value: unknown): string {
  if (typeof value !== 'string' || !MIDEN_ACCOUNT_ID.test(value)) return invalid();
  return value.toLowerCase();
}

// A base the wallet appends routes to, so it carries no credentials, query or fragment.
function baseUrl(value: unknown, allowLocalHttp: boolean): string {
  if (typeof value !== 'string') return invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid();
  }
  const localHttp = allowLocalHttp && url.protocol === 'http:' && LOCAL_HTTP_HOSTS.includes(url.hostname);
  if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password || url.search || url.hash) {
    return invalid();
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function featureSwitch(features: Record<string, unknown>, name: string): boolean {
  const value = features[name];
  if (value === undefined) return false;
  return typeof value === 'boolean' ? value : invalid();
}

// Undefined for anything but the one accepted spelling of a real instant. Engines differ on an impossible day
// (V8 rolls 2026-02-30 over to March), so the date must survive a round trip through toISOString.
function utcTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !UTC_TIMESTAMP.test(value)) return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19) ? parsed : undefined;
}

// Never throws: a countdown that is malformed in any way is off, and the rest of the document still counts.
function readCountdown(value: unknown): MainnetCountdownConfig {
  if (value === undefined || !isRecord(value)) return { enabled: false };
  const { enabled, launchAt } = value;
  if (enabled !== undefined && typeof enabled !== 'boolean') return { enabled: false };
  const moment = launchAt === undefined ? undefined : utcTimestamp(launchAt);
  if (launchAt !== undefined && moment === undefined) return { enabled: false };
  return { enabled: enabled === true, ...(moment === undefined ? {} : { launchAt: moment }) };
}

function swapTokenLogo(value: unknown): SwapTokenLogo | undefined {
  if (typeof value !== 'string') return invalid();
  return SUPPORTED_SWAP_TOKEN_LOGOS.find(logo => logo === value);
}

// A symbol the feed does not quote is dropped, not an error: the token is then unpriced, like any unknown token.
function priceSymbol(value: unknown): string | undefined {
  if (typeof value !== 'string') return invalid();
  return typeof KNOWN_SYMBOLS[value] === 'string' ? value : undefined;
}

function tokenSymbol(value: unknown): string {
  if (typeof value !== 'string' || !TOKEN_SYMBOL.test(value)) return invalid();
  return value;
}

function tokenDecimals(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_SWAP_TOKEN_DECIMALS) {
    return invalid();
  }
  return value;
}

function readSwapToken(value: unknown): SwapTokenConfig {
  if (!isRecord(value)) return invalid();
  const symbol = tokenSymbol(value.symbol);
  const faucetId = midenAccountId(value.faucetId);
  const decimals = tokenDecimals(value.decimals);
  const logo = read(value, 'logo', swapTokenLogo);
  const priced = read(value, 'priceSymbol', priceSymbol);
  return {
    symbol,
    faucetId,
    decimals,
    ...(logo === undefined ? {} : { logo }),
    ...(priced === undefined ? {} : { priceSymbol: priced })
  };
}

// The list in the document's order. Two entries for one faucet, or one symbol, would make the picker ambiguous.
function readSwapTokens(value: unknown): SwapTokenConfig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return invalid();
  const tokens = value.map(readSwapToken);
  const faucetIds = new Set(tokens.map(token => token.faucetId));
  const symbols = new Set(tokens.map(token => token.symbol));
  if (faucetIds.size !== tokens.length || symbols.size !== tokens.length) return invalid();
  return tokens;
}

type ConfigValue = Parameters<typeof section>[0];

function requiredBoolean(value: ConfigValue): boolean {
  return typeof value === 'boolean' ? value : invalid();
}

function domain(value: ConfigValue): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) return invalid();
  return value;
}

function switches(value: Record<string, ConfigValue>): RouteSwitches {
  return {
    depositEnabled: requiredBoolean(value.depositEnabled),
    withdrawalEnabled: requiredBoolean(value.withdrawalEnabled)
  };
}

function outputNames(value: ConfigValue): string[] {
  if (!Array.isArray(value) || !value.every((name: ConfigValue) => typeof name === 'string')) return invalid();
  const names: string[] = [];
  for (const name of value) {
    if (typeof name !== 'string' || name !== 'usdc-testnet-output') return invalid();
    names.push(name);
  }
  if (new Set(names).size !== names.length) return invalid();
  return names;
}

function epochChain(value: ConfigValue): EpochChainConfig {
  const bridge = section(value);
  const token = section(section(bridge.tokens).USDC);
  return {
    ...switches(bridge),
    tokens: {
      USDC: {
        contractAddress: evmAddress(token.contractAddress),
        outputs: token.outputs === undefined ? [] : outputNames(token.outputs)
      }
    }
  };
}

function agglayerChain(value: ConfigValue): AgglayerChainConfig {
  const bridge = section(value);
  return {
    ...switches(bridge),
    contractAddress: evmAddress(bridge.contractAddress),
    midenBridgeId: midenAccountId(bridge.midenBridgeId)
  };
}

function usdcxDeposit(value: ConfigValue): UsdcxDepositConfig {
  const deposit = section(value);
  switch (deposit.route) {
    case 'xreserve':
      return { route: 'xreserve', xReserve: evmAddress(deposit.xReserve) };
    case 'executor':
      if (typeof deposit.executorChain !== 'string' || !deposit.executorChain) return invalid();
      return {
        route: 'executor',
        executorChain: deposit.executorChain,
        tokenMessenger: evmAddress(deposit.tokenMessenger),
        tokenMessengerWithFees: evmAddress(deposit.tokenMessengerWithFees)
      };
    default:
      return invalid();
  }
}

function usdcxChain(value: ConfigValue): UsdcxChainConfig {
  const bridge = section(value);
  const token = section(section(bridge.tokens).USDC);
  const deposit = read(bridge, 'deposit', usdcxDeposit);
  const executor = read(bridge, 'executor', value => {
    const addresses = section(value);
    return { address: evmAddress(addresses.address), handler: evmAddress(addresses.handler) };
  });
  if (bridge.depositEnabled === true && !deposit) return invalid();
  if (executor && deposit?.route !== 'xreserve') return invalid();
  return {
    ...switches(bridge),
    domain: domain(bridge.domain),
    tokens: { USDC: { contractAddress: evmAddress(token.contractAddress) } },
    ...(deposit === undefined ? {} : { deposit }),
    ...(executor === undefined ? {} : { executor })
  };
}

function supportedChains(value: ConfigValue): Record<string, SupportedEvmChainConfig> {
  const chains: Record<string, SupportedEvmChainConfig> = {};
  const ids = new Set<number>();
  for (const [slug, entry] of Object.entries(section(value))) {
    if (!/^[a-z][a-z0-9-]*$/.test(slug)) return invalid();
    const item = section(entry);
    if (!isPositiveSafeInteger(item.chainId) || ids.has(item.chainId) || evmChainSlug(item.chainId) !== slug)
      return invalid();
    ids.add(item.chainId);
    const bridges = section(item.bridges);
    const epoch = read(bridges, 'epoch', epochChain);
    const agglayer = read(bridges, 'agglayer', agglayerChain);
    const usdcx = read(bridges, 'usdcx', usdcxChain);
    chains[slug] = {
      chainId: item.chainId,
      bridges: {
        ...(epoch === undefined ? {} : { epoch }),
        ...(agglayer === undefined ? {} : { agglayer }),
        ...(usdcx === undefined ? {} : { usdcx })
      }
    };
  }
  for (const chain of Object.values(chains)) {
    const deposit = chain.bridges.usdcx?.deposit;
    if (deposit?.route !== 'executor') continue;
    const target = chains[deposit.executorChain]?.bridges.usdcx;
    if (!target?.executor || target.deposit?.route !== 'xreserve') return invalid();
  }
  return chains;
}

function readConfig(body: unknown, network: string, allowLocalHttp: boolean): BridgeConfig {
  if (!isRecord(body)) return invalid();
  const { version } = body;
  if (body.network !== network || !isPositiveSafeInteger(version)) return invalid();
  const url = (value: ConfigValue) => baseUrl(value, allowLocalHttp);
  const providers = section(body['bridge-providers']);
  const epoch = section(providers.epoch);
  const agglayer = section(providers.agglayer);
  const usdcx = section(providers.usdcx);
  const outputs: Record<string, { faucetId: string }> = {};
  for (const [name, output] of Object.entries(section(epoch.outputs))) {
    if (name !== 'usdc-testnet-output' || network !== 'testnet') return invalid();
    outputs[name] = { faucetId: midenAccountId(section(output).faucetId) };
  }
  const allocatorUrl = read(epoch, 'allocatorUrl', url);
  const positionsUrl = read(epoch, 'positionsUrl', url);
  const indexerUrl = read(agglayer, 'indexerUrl', url);
  const midenDomain = read(usdcx, 'midenDomain', domain);
  const attestationUrl = read(usdcx, 'attestationUrl', url);
  const irisUrl = read(usdcx, 'irisUrl', url);
  const swap = section(body.swap);
  const etaUrl = read(swap, 'etaUrl', url);
  const supportedEvmChains = supportedChains(body.supportedEvmChains);
  for (const chain of Object.values(supportedEvmChains)) {
    if (chain.bridges.epoch && (!allocatorUrl || !positionsUrl)) return invalid();
    if (chain.bridges.agglayer && !indexerUrl) return invalid();
    if (chain.bridges.usdcx && (midenDomain === undefined || !attestationUrl || !irisUrl)) return invalid();
    for (const name of chain.bridges.epoch?.tokens.USDC?.outputs ?? []) {
      if (!outputs[name]) return invalid();
    }
  }
  return {
    network,
    version,
    'bridge-providers': {
      epoch: {
        ...(allocatorUrl === undefined ? {} : { allocatorUrl }),
        ...(positionsUrl === undefined ? {} : { positionsUrl }),
        ...(Object.keys(outputs).length === 0 ? {} : { outputs })
      },
      agglayer: { ...(indexerUrl === undefined ? {} : { indexerUrl }) },
      usdcx: {
        ...(midenDomain === undefined ? {} : { midenDomain }),
        ...(attestationUrl === undefined ? {} : { attestationUrl }),
        ...(irisUrl === undefined ? {} : { irisUrl })
      }
    },
    supportedEvmChains,
    features: { earn: featureSwitch(section(body.features), 'earn') },
    mainnetCountdown: readCountdown(body.mainnetCountdown),
    swap: { tokens: readSwapTokens(swap.tokens), ...(etaUrl === undefined ? {} : { etaUrl }) }
  };
}

/**
 * The document for `network`, or null when it is malformed or names another network. Strict on known fields,
 * blind to unknown ones. URLs come back without a trailing slash; addresses and ids in lowercase.
 */
export function parseBridgeConfig(
  body: unknown,
  network: string,
  options: { allowLocalHttp?: boolean } = {}
): BridgeConfig | null {
  try {
    return readConfig(body, network, options.allowLocalHttp === true);
  } catch {
    return null;
  }
}
