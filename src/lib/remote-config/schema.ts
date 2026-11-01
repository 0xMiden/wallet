import { isRecord } from 'lib/update/guards';
import { SUPPORTED_CHAINS } from 'lib/walletconnect/config';

import { evmChainSlug } from './chains';
import { type GeoBlocks, readGeoBlocks } from './geo';
import { parseOneClickEvmAssets } from '../one-click/identity';
import type { OneClickEvmAssetConfig } from '../one-click/types';

/** The per-feature switches a document carries; each stops new starts only. */
export const BRIDGE_SWITCHES: readonly BridgeSwitch[] = ['earn'];
export type BridgeSwitch = 'earn';

export interface OneClickMidenAssetConfig {
  assetId: string;
  faucetId: string;
  decimals: number;
}

export interface OneClickAppFeeConfig {
  recipient: string;
  fee: number;
}

export interface OneClickConfig {
  serviceUrl: string;
  midenAssets: OneClickMidenAssetConfig[];
  evmAssets?: OneClickEvmAssetConfig[];
  appFees?: OneClickAppFeeConfig[];
}

export interface SwapConfig {
  /**
   * The DEX solver's base URL. The swap registry is its `/v2/pairs` (see `swap-pairs.ts`), and
   * `lib/miden/swap/quote` appends `/v2/pair-price` and `/v2/swap-eta` to it; absent means no swap
   * tokens and no quotes.
   */
  etaUrl?: string;
  oneClick?: OneClickConfig;
}

/** The picker pings every listed Guardian operator, so the list is bounded. */
export const MAX_GUARDIANS = 16;
export const MAX_GUARDIAN_ID_LENGTH = 32;
/** The longest name, operator or location the wallet shows. */
export const MAX_GUARDIAN_LABEL_LENGTH = 48;
/** The longest `about` sentence and `kind` line the wallet shows. */
export const MAX_GUARDIAN_ABOUT_LENGTH = 160;
export const MAX_GUARDIAN_KIND_LENGTH = 64;
/** Ids the wallet gives its own entries: the developer's custom endpoint and the no-Guardian choice. */
export const RESERVED_GUARDIAN_IDS: readonly string[] = ['custom', 'no-guardian'];

/** A Guardian operator as the document lists it: the shape of `ResolvedGuardianOption`. */
export interface GuardianConfig {
  /** Unique in the list. Keys the bundled logo and description; an id with neither shows `name` and `operatedBy`. */
  id: string;
  name: string;
  operatedBy: string;
  location: string;
  /** The Guardian base URL, without a trailing slash; unique in the list. */
  endpoint: string;
  /** Who runs the operator, in one English sentence: the guardian step shows it under the operator's name. */
  about?: string;
  /** What kind of company runs the operator, in a short English line: the Change provider sheet shows it. */
  kind?: string;
}

/** EVM chains the wallet ships RPC and explorer definitions for: the WalletConnect chain registry (Sepolia). */
export const SUPPORTED_EVM_CHAIN_IDS: readonly number[] = SUPPORTED_CHAINS.map(chain => chain.id);

/**
 * The protocol strings a listed Earn vault can name. A deposit's `protocolHashIdentifier` is
 * `keccak256(toBytes(protocol))`. The testnet deposits use the hash of `dummy-lending`.
 */
export const EARN_VAULT_PROTOCOLS = ['1delta', 'dummy-lending'] as const;
export type EarnVaultProtocol = (typeof EARN_VAULT_PROTOCOLS)[number];

/** The risk levels a listed Earn vault can name. */
export const EARN_VAULT_RISKS = ['low', 'medium', 'high'] as const;
export type EarnVaultRisk = (typeof EARN_VAULT_RISKS)[number];

/** The longest vault name and `about` sentence the wallet shows. */
export const MAX_EARN_VAULT_NAME_LENGTH = 64;
export const MAX_EARN_VAULT_ABOUT_LENGTH = 200;

/**
 * A vault's `logo`: a file under `icons/` of the config repo, relative to the base URL the document was fetched from.
 * The rule of the config repo's validator (scripts/validate.mjs).
 */
export const EARN_VAULT_LOGO = /^icons\/[a-z0-9]+(-[a-z0-9]+)*\.(svg|png)$/;

/**
 * An Earn vault as the document lists it. The list is the only source of the vaults the wallet offers: a market of
 * the Epoch catalogue that no entry names is not offered. The text fields are literal: the wallet shows them as
 * written in every language.
 */
export interface EarnVaultConfig {
  /** Unique in the list: `^[a-z][a-z0-9-]*$`. The vault's route id (`/earn/vaults/{id}`). */
  id: string;
  /** `LENDER_KEY:chainId:underlying`, lowercase; unique in the list. */
  marketUid: string;
  name: string;
  /** The protocol string a deposit hashes into its `protocolHashIdentifier`. */
  protocol: EarnVaultProtocol;
  about?: string;
  risk?: EarnVaultRisk;
  /** False when the document stops new deposits into the vault. True when the document does not set it. */
  depositsEnabled: boolean;
  /**
   * The vault's mark, a path such as `icons/aave.svg` relative to the document's base URL (`EARN_VAULT_LOGO`).
   * Several vaults may name one file. Resolve it with `selectEarnVaultLogoUrl`.
   */
  logo?: string;
}

/** A 20-byte EVM address, lowercase. */
export type EvmAddress = `0x${string}`;

/** The switch and moment behind the mainnet countdown banner. `launchAt` is epoch milliseconds, UTC. */
export interface MainnetCountdownConfig {
  enabled: boolean;
  launchAt?: number;
}

/**
 * The ceilings the document puts on bridge transfers. `bridgeInMaxBalanceUsd` is the most the receiving account may
 * hold, in US dollars, once a bridge-in lands: the wallet refuses a deposit that takes the account's valued balance
 * past it. Absent means no ceiling.
 */
export interface BridgeLimitsConfig {
  bridgeInMaxBalanceUsd?: number;
}

export interface RouteSwitches {
  depositEnabled: boolean;
  withdrawalEnabled: boolean;
}

/**
 * One token of an Epoch route. The Miden faucet the solver settles it into is the token-list's entry for
 * `midenSymbol` (the token's own key when absent), unless `outputs` names entries of `bridge-providers.epoch.outputs`:
 * then it is the first one's, as on testnet, whose Epoch faucet the token-list does not list.
 */
export interface EpochTokenConfig {
  contractAddress: EvmAddress;
  midenSymbol?: string;
  outputs: string[];
}

export interface EpochChainConfig extends RouteSwitches {
  /** The EVM tokens the route carries, keyed by the symbol the wallet shows. Never empty. */
  tokens: Record<string, EpochTokenConfig>;
}

export interface AgglayerDepositTokenConfig {
  contractAddress: EvmAddress;
}

export interface AgglayerChainConfig extends RouteSwitches {
  contractAddress: EvmAddress;
  midenBridgeId: string;
  /**
   * The ERC-20 source tokens the document lists for a deposit, by the symbol the picker shows. Native ETH is never
   * listed: the wallet finds it in the bridge's faucet registry, which is also what verifies each token here.
   * Absent when the document lists none.
   */
  tokens?: Record<string, AgglayerDepositTokenConfig>;
  /**
   * A Blockscout API root (`.../api/v2`) that lists an address's ERC-20 holdings on this chain. On a test network the
   * picker offers the connected wallet's holdings through it; absent, and on mainnet, only `tokens` are offered.
   */
  tokenApiUrl?: string;
}

export type UsdcxDepositConfig =
  | { route: 'xreserve'; xReserve: EvmAddress }
  | { route: 'executor'; executorChain: string; tokenMessengerWithFees: EvmAddress };

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
  /** The native-ETH faucet that sends this chain's bridged-ETH deliveries, and its scale; absent on older rows. */
  nativeEthFaucetId?: string;
  nativeEthScale?: number;
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
  features: {
    earn: boolean;
    nearIntents: boolean;
    fastBridge?: boolean;
    bridgeIn?: boolean;
    bridgeOut?: boolean;
    /** Buying Game Coins in Arcade; only there when the document sets it, and `arcade` exists exactly when true. */
    arcadeGcPurchase?: boolean;
    /**
     * The encrypted multi-device backup; only there when the document sets it, absent means off, and `backup` exists
     * exactly when true.
     */
    encryptedBackup?: boolean;
  };
  /**
   * Places where a feature must not start. Only the "yes" answers are kept. Absent means no place
   * blocks the feature. A withdrawal of an existing Earn position is not a start.
   */
  geo?: GeoBlocks;
  /**
   * The mainnet launch. Before its moment Welcome shows the create and recover flows, with the logo taps
   * as the unlock of the invite-only way in; from the moment on Welcome shows the invite-only way in
   * directly and an existing test-network wallet is offered the switch to mainnet. The document's
   * `onboarding.inviteOnly` is no longer read: the moment is the one switch.
   */
  mainnetCountdown?: MainnetCountdownConfig;
  /** Only there when the document sets a `limits` section. */
  limits?: BridgeLimitsConfig;
  swap?: SwapConfig;
  /**
   * The network's Guardian operators in picker order, the first being the default. Never empty. Absent means the
   * document names none, and the wallet uses the list it ships with (`lib/miden-chain/guardian-registry`).
   */
  guardians?: GuardianConfig[];
  /**
   * The Earn vaults the wallet offers, in picker order. Present, and never empty, exactly when `features.earn` is
   * true.
   */
  earn?: { vaults: EarnVaultConfig[] };
  /**
   * The Arcade sale configuration. The seller field is retained for compatibility; purchases accept any seller
   * with the required script, asset pair and price. Present
   * exactly when `features.arcadeGcPurchase` is true (`lib/miden/arcade/gc-sale.ts`).
   */
  arcade?: { sale: { seller: string } };
  /**
   * The encrypted backup service (`services/wallet-api`). Present exactly when `features.encryptedBackup` is true
   * (`lib/backup/api-client.ts`).
   */
  backup?: BackupConfig;
}

export interface BackupConfig {
  /** The service's base URL: absolute `https:`, without credentials, query, fragment or trailing slash. */
  baseUrl: string;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MIDEN_ACCOUNT_ID = /^0x[0-9a-fA-F]{30}$/;
// An ERC-20 symbol as an AggLayer or Epoch route keys it: 1 to 11 upper-case ASCII letters or digits. The same rule
// as the config repo's validator (scripts/validate.mjs).
const BRIDGE_TOKEN_SYMBOL = /^[A-Z0-9]{1,11}$/;
// Lower-case letters and digits in groups joined by single hyphens.
const GUARDIAN_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// C0 controls, DEL and C1 controls: none belongs in a line of text the wallet shows.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
// An RFC 3339 timestamp in UTC, such as 2026-10-26T00:00:00Z: one spelling, so every wallet reads the same instant.
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
// The Earn vault rules of the config repo's validator (scripts/validate.mjs).
const EARN_VAULT_ID = /^[a-z][a-z0-9-]*$/;
const EARN_LENDER_KEY = /^[A-Z0-9_]+$/;
const EARN_CHAIN_ID = /^[1-9][0-9]*$/;
const LOWERCASE_EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const LOCAL_HTTP_HOSTS = ['127.0.0.1', 'localhost'];

// Each check throws on a violation and parseBridgeConfig catches once: one bad known field rejects the document.
// What this build does not know or cannot complete (a newer chain, route, token or output) is left out instead, so
// only its own routes go unavailable. mainnetCountdown is off when malformed: no banner and no launch.
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

function oneClick(
  value: unknown,
  network: string,
  allowLocalHttp: boolean,
  allowOneClickLocalE2E: boolean
): OneClickConfig | undefined {
  if (network !== 'mainnet' && !(network === 'localnet' && allowOneClickLocalE2E)) return undefined;
  const config = section(value);
  const serviceUrl = baseUrl(config.serviceUrl, network === 'localnet' && allowOneClickLocalE2E && allowLocalHttp);
  if (network === 'localnet' && allowOneClickLocalE2E && !LOCAL_HTTP_HOSTS.includes(new URL(serviceUrl).hostname))
    return invalid();
  const entries = config.midenAssets;
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 64) return invalid();
  const ids = new Set<string>();
  const faucets = new Set<string>();
  const midenAssets = entries.map(entry => {
    const asset = section(entry);
    if (
      typeof asset.assetId !== 'string' ||
      asset.assetId.length < 1 ||
      asset.assetId.length > 256 ||
      CONTROL_CHARACTER.test(asset.assetId)
    )
      return invalid();
    const assetId = asset.assetId;
    const faucetId = midenAccountId(asset.faucetId);
    if (!isSafeIntegerInRange(asset.decimals, 0, 38) || ids.has(assetId) || faucets.has(faucetId)) return invalid();
    ids.add(assetId);
    faucets.add(faucetId);
    return { assetId, faucetId, decimals: asset.decimals };
  });
  const evmAssets = parseOneClickEvmAssets(config.evmAssets, ids);
  let appFees: OneClickAppFeeConfig[] | undefined;
  if (config.appFees !== undefined) {
    if (!Array.isArray(config.appFees) || config.appFees.length > 3) return invalid();
    appFees = config.appFees.map(entry => {
      const fee = section(entry);
      if (
        typeof fee.recipient !== 'string' ||
        fee.recipient.length < 2 ||
        fee.recipient.length > 64 ||
        !/^[a-z0-9._-]+$/.test(fee.recipient)
      )
        return invalid();
      if (!isSafeIntegerInRange(fee.fee, 0, 1000)) return invalid();
      return { recipient: fee.recipient, fee: fee.fee };
    });
    if (appFees.reduce((sum, fee) => sum + fee.fee, 0) > 1000) return invalid();
  }
  return { serviceUrl, midenAssets, evmAssets, ...(appFees === undefined ? {} : { appFees }) };
}

function isSafeIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
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

type ConfigValue = Parameters<typeof section>[0];

// A ceiling in US dollars: a finite number above zero. A malformed ceiling fails the document, since a ceiling the
// wallet silently dropped would let a deposit through that the operator meant to refuse.
function usdCeiling(value: ConfigValue): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return invalid();
  return value;
}

function readLimits(value: ConfigValue): BridgeLimitsConfig | undefined {
  if (value === undefined) return undefined;
  const bridgeInMaxBalanceUsd = read(section(value), 'bridgeInMaxBalanceUsd', usdCeiling);
  return bridgeInMaxBalanceUsd === undefined ? undefined : { bridgeInMaxBalanceUsd };
}

/**
 * The Arcade GC sale (the config repo's `readArcade`): the section exists exactly while `features.arcadeGcPurchase`
 * is on, so a stale seller cannot linger behind a switched-off feature, and names the seller as a 15-byte hex
 * account id. A bad section rejects the document.
 */
function readArcade(value: ConfigValue, enabled: boolean): { sale: { seller: string } } | undefined {
  if (value === undefined) return enabled ? invalid() : undefined;
  if (!enabled) return invalid();
  const sale = section(section(value).sale);
  const seller = read(sale, 'seller', candidate =>
    typeof candidate === 'string' && MIDEN_ACCOUNT_ID.test(candidate) ? candidate.toLowerCase() : invalid()
  );
  return seller === undefined ? invalid() : { sale: { seller } };
}

// The backup service's base URL as the config repo's validator accepts it: an absolute https URL with a host and no
// credentials, query, fragment or trailing slash. The wallet appends its `/v1/...` routes to it.
function backupBaseUrl(value: ConfigValue): string {
  if (typeof value !== 'string' || value.endsWith('/') || value.includes('?') || value.includes('#')) return invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid();
  }
  if (url.protocol !== 'https:' || url.hostname === '' || url.username || url.password || url.search || url.hash) {
    return invalid();
  }
  return `${url.origin}${url.pathname === '/' ? '' : url.pathname}`;
}

/**
 * The encrypted backup service (the config repo's `readBackup`): the section exists exactly while
 * `features.encryptedBackup` is on, so a stale URL cannot linger behind a switched-off feature, and names the
 * service's base URL. A bad section rejects the document.
 */
function readBackup(value: ConfigValue, enabled: boolean): BackupConfig | undefined {
  if (value === undefined) return enabled ? invalid() : undefined;
  if (!enabled) return invalid();
  const baseUrl = read(section(value), 'baseUrl', backupBaseUrl);
  return baseUrl === undefined ? invalid() : { baseUrl };
}

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
  if (!Array.isArray(value)) return invalid();
  const names = value.map((name: ConfigValue) => (typeof name === 'string' ? name : invalid()));
  if (new Set(names).size !== names.length) return invalid();
  return names;
}

// Undefined for a route that lists no token. A map keyed by symbol, each entry an EVM address, no address twice: the
// rules the config repo's validator applies.
function epochChain(value: ConfigValue): EpochChainConfig | undefined {
  const bridge = section(value);
  const routeSwitches = switches(bridge);
  const tokens: Record<string, EpochTokenConfig> = {};
  const addresses = new Set<string>();
  for (const [symbol, entry] of Object.entries(section(bridge.tokens))) {
    if (!BRIDGE_TOKEN_SYMBOL.test(symbol)) return invalid();
    const token = section(entry);
    const contractAddress = evmAddress(token.contractAddress);
    if (addresses.has(contractAddress)) return invalid();
    addresses.add(contractAddress);
    const midenSymbol = read(token, 'midenSymbol', value =>
      typeof value === 'string' && BRIDGE_TOKEN_SYMBOL.test(value) ? value : invalid()
    );
    tokens[symbol] = {
      contractAddress,
      ...(midenSymbol === undefined ? {} : { midenSymbol }),
      outputs: token.outputs === undefined ? [] : outputNames(token.outputs)
    };
  }
  if (Object.keys(tokens).length === 0) return undefined;
  return { ...routeSwitches, tokens };
}

// A map keyed by symbol, each entry an EVM address, no address twice: the rules the config repo's validator applies.
function agglayerDepositTokens(value: ConfigValue): Record<string, AgglayerDepositTokenConfig> {
  const tokens: Record<string, AgglayerDepositTokenConfig> = {};
  const addresses = new Set<string>();
  for (const [symbol, token] of Object.entries(section(value))) {
    if (!BRIDGE_TOKEN_SYMBOL.test(symbol)) return invalid();
    const contractAddress = evmAddress(section(token).contractAddress);
    if (addresses.has(contractAddress)) return invalid();
    addresses.add(contractAddress);
    tokens[symbol] = { contractAddress };
  }
  return tokens;
}

function agglayerChain(value: ConfigValue, url: (value: ConfigValue) => string): AgglayerChainConfig {
  const bridge = section(value);
  const tokens = read(bridge, 'tokens', agglayerDepositTokens);
  const tokenApiUrl = read(bridge, 'tokenApiUrl', url);
  return {
    ...switches(bridge),
    contractAddress: evmAddress(bridge.contractAddress),
    midenBridgeId: midenAccountId(bridge.midenBridgeId),
    ...(tokens === undefined ? {} : { tokens }),
    ...(tokenApiUrl === undefined ? {} : { tokenApiUrl })
  };
}

// Undefined for a route this build does not know.
function usdcxDeposit(value: ConfigValue): UsdcxDepositConfig | undefined {
  const deposit = section(value);
  switch (deposit.route) {
    case 'xreserve':
      return { route: 'xreserve', xReserve: evmAddress(deposit.xReserve) };
    case 'executor':
      if (typeof deposit.executorChain !== 'string' || !deposit.executorChain) return invalid();
      return {
        route: 'executor',
        executorChain: deposit.executorChain,
        tokenMessengerWithFees: evmAddress(deposit.tokenMessengerWithFees)
      };
    default:
      return typeof deposit.route === 'string' ? undefined : invalid();
  }
}

// Undefined for a route that lists no token this build knows. A deposit it does not know is left out, and the executor
// with it, since an executor serves only an xreserve deposit.
function usdcxChain(value: ConfigValue): UsdcxChainConfig | undefined {
  const bridge = section(value);
  const routeSwitches = switches(bridge);
  const routeDomain = domain(bridge.domain);
  const deposit = read(bridge, 'deposit', usdcxDeposit);
  const dropped = bridge.deposit !== undefined && deposit === undefined;
  const executor = read(bridge, 'executor', value => {
    const addresses = section(value);
    return { address: evmAddress(addresses.address), handler: evmAddress(addresses.handler) };
  });
  if (bridge.depositEnabled === true && !deposit && !dropped) return invalid();
  if (executor && !dropped && deposit?.route !== 'xreserve') return invalid();
  const tokens = section(bridge.tokens);
  if (tokens.USDC === undefined) return undefined;
  const token = section(tokens.USDC);
  return {
    ...routeSwitches,
    domain: routeDomain,
    tokens: { USDC: { contractAddress: evmAddress(token.contractAddress) } },
    ...(deposit === undefined ? {} : { deposit }),
    ...(executor === undefined || dropped ? {} : { executor })
  };
}

function supportedChains(
  value: ConfigValue,
  url: (value: ConfigValue) => string
): Record<string, SupportedEvmChainConfig> {
  const chains: Record<string, SupportedEvmChainConfig> = {};
  const ids = new Set<number>();
  // Chains skipped, or whose xreserve deposit was left out: an executor deposit through one is left out too.
  const incomplete = new Set<string>();
  for (const [slug, entry] of Object.entries(section(value))) {
    if (!/^[a-z][a-z0-9-]*$/.test(slug)) return invalid();
    const item = section(entry);
    if (!isPositiveSafeInteger(item.chainId) || ids.has(item.chainId)) return invalid();
    // A chain id this build has no name for is a newer build's; one it names under another slug is a mistake.
    const known = evmChainSlug(item.chainId);
    if (known === undefined) {
      incomplete.add(slug);
      continue;
    }
    if (known !== slug) return invalid();
    ids.add(item.chainId);
    const bridges = section(item.bridges);
    const epoch = read(bridges, 'epoch', epochChain);
    const agglayer = read(bridges, 'agglayer', value => agglayerChain(value, url));
    const usdcx = read(bridges, 'usdcx', usdcxChain);
    if (section(bridges.usdcx).deposit !== undefined && !usdcx?.deposit) incomplete.add(slug);
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
    const route = chain.bridges.usdcx;
    if (route?.deposit?.route !== 'executor') continue;
    const target = chains[route.deposit.executorChain]?.bridges.usdcx;
    if (target?.executor && target.deposit?.route === 'xreserve') continue;
    if (!incomplete.has(route.deposit.executorChain)) return invalid();
    delete route.deposit;
  }
  return chains;
}

function guardianId(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_GUARDIAN_ID_LENGTH || !GUARDIAN_ID.test(value)) return invalid();
  return RESERVED_GUARDIAN_IDS.includes(value) ? invalid() : value;
}

// A line of text the wallet shows as written: 1 to `maxLength` characters, no control character, no space at either
// end.
function guardianLabel(value: unknown, maxLength = MAX_GUARDIAN_LABEL_LENGTH): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return invalid();
  return value !== value.trim() || CONTROL_CHARACTER.test(value) ? invalid() : value;
}

function readGuardian(value: unknown, url: (value: unknown) => string): GuardianConfig {
  if (!isRecord(value)) return invalid();
  // Optional: without them the wallet shows its bundled words for the id, else `operatedBy`.
  const about = value.about === undefined ? undefined : guardianLabel(value.about, MAX_GUARDIAN_ABOUT_LENGTH);
  const kind = value.kind === undefined ? undefined : guardianLabel(value.kind, MAX_GUARDIAN_KIND_LENGTH);
  return {
    id: guardianId(value.id),
    name: guardianLabel(value.name),
    operatedBy: guardianLabel(value.operatedBy),
    location: guardianLabel(value.location),
    endpoint: url(value.endpoint),
    ...(about === undefined ? {} : { about }),
    ...(kind === undefined ? {} : { kind })
  };
}

// The list in the document's order. An empty list would leave a new wallet with no operator to choose, so it is
// refused: a document that names no operator omits the field. Two entries for one id or one endpoint are ambiguous.
function readGuardians(value: unknown, url: (value: unknown) => string): GuardianConfig[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_GUARDIANS) return invalid();
  const guardians = value.map(entry => readGuardian(entry, url));
  const ids = new Set(guardians.map(guardian => guardian.id));
  const endpoints = new Set(guardians.map(guardian => guardian.endpoint));
  if (ids.size !== guardians.length || endpoints.size !== guardians.length) return invalid();
  return guardians;
}

const member = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

// The USDC contract of each Epoch route, lowercase, by chain id: the markets a vault can name. Read from the document
// as written, as the config repo's validator reads it, so a chain or route this build leaves out (a newer build's
// chain, a route with no provider values) still names its vaults. A route with no USDC address names none.
function epochUsdcByChain(value: unknown): Map<number, string | undefined> {
  const routes = new Map<number, string | undefined>();
  if (!isRecord(value)) return routes;
  for (const entry of Object.values(value)) {
    const chainId = member(entry, 'chainId');
    const epoch = member(member(entry, 'bridges'), 'epoch');
    if (!isPositiveSafeInteger(chainId) || !isRecord(epoch)) continue;
    const usdc = member(member(member(epoch, 'tokens'), 'USDC'), 'contractAddress');
    routes.set(chainId, typeof usdc === 'string' ? usdc.toLowerCase() : undefined);
  }
  return routes;
}

// `LENDER_KEY:chainId:underlying` of an Epoch route's own USDC, lowercase.
function earnMarketUid(value: unknown, routes: Map<number, string | undefined>): string {
  if (typeof value !== 'string') return invalid();
  const parts = value.split(':');
  const [lenderKey = '', chainId = '', underlying = ''] = parts;
  if (parts.length !== 3 || !EARN_LENDER_KEY.test(lenderKey) || !EARN_CHAIN_ID.test(chainId)) return invalid();
  if (!LOWERCASE_EVM_ADDRESS.test(underlying) || !Number.isSafeInteger(Number(chainId))) return invalid();
  const usdc = routes.get(Number(chainId));
  return usdc !== undefined && usdc === underlying ? value.toLowerCase() : invalid();
}

// Literal text, shown as written: 1 to `maxLength` characters. Unlike a Guardian's text, neither the config repo's
// validator nor this parser checks its characters or spaces.
function earnVaultText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return invalid();
  return value;
}

// A path under `icons/`, never a URL: the wallet resolves it against the document's own base URL.
function earnVaultLogo(value: unknown): string {
  return typeof value === 'string' && EARN_VAULT_LOGO.test(value) ? value : invalid();
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T {
  return values.find(known => known === value) ?? invalid();
}

function readEarnVault(value: unknown, routes: Map<number, string | undefined>): EarnVaultConfig {
  if (!isRecord(value)) return invalid();
  if (typeof value.id !== 'string' || !EARN_VAULT_ID.test(value.id)) return invalid();
  const about = read(value, 'about', about => earnVaultText(about, MAX_EARN_VAULT_ABOUT_LENGTH));
  const risk = read(value, 'risk', risk => oneOf(EARN_VAULT_RISKS, risk));
  const logo = read(value, 'logo', earnVaultLogo);
  return {
    id: value.id,
    marketUid: earnMarketUid(value.marketUid, routes),
    name: earnVaultText(value.name, MAX_EARN_VAULT_NAME_LENGTH),
    protocol: oneOf(EARN_VAULT_PROTOCOLS, value.protocol),
    ...(about === undefined ? {} : { about }),
    ...(risk === undefined ? {} : { risk }),
    depositsEnabled: read(value, 'depositsEnabled', requiredBoolean) ?? true,
    ...(logo === undefined ? {} : { logo })
  };
}

// The section exists exactly when Earn is on: Earn on with no vault would offer nothing, and vaults with Earn off
// would be a list nothing reads. Two entries for one id or one market are ambiguous.
function readEarn(value: unknown, earnEnabled: boolean, chains: unknown): { vaults: EarnVaultConfig[] } | undefined {
  if (value === undefined) return earnEnabled ? invalid() : undefined;
  if (!earnEnabled || !isRecord(value) || !Array.isArray(value.vaults) || value.vaults.length === 0) return invalid();
  const routes = epochUsdcByChain(chains);
  const vaults = value.vaults.map((entry: unknown) => readEarnVault(entry, routes));
  const ids = new Set(vaults.map(vault => vault.id));
  const markets = new Set(vaults.map(vault => vault.marketUid));
  if (ids.size !== vaults.length || markets.size !== vaults.length) return invalid();
  return { vaults };
}

function readConfig(
  body: unknown,
  network: string,
  allowLocalHttp: boolean,
  allowOneClickLocalE2E: boolean
): BridgeConfig {
  if (!isRecord(body)) return invalid();
  const { version } = body;
  if (body.network !== network || !isPositiveSafeInteger(version)) return invalid();
  const url = (value: ConfigValue) => baseUrl(value, allowLocalHttp);
  const providers = section(body['bridge-providers']);
  const epoch = section(providers.epoch);
  const agglayer = section(providers.agglayer);
  const usdcx = section(providers.usdcx);
  // fromEntries, so a name such as __proto__ is an own entry like any other.
  const outputs: Record<string, { faucetId: string }> = Object.fromEntries(
    Object.entries(section(epoch.outputs)).map(([name, output]) => [
      name,
      { faucetId: midenAccountId(section(output).faucetId) }
    ])
  );
  const allocatorUrl = read(epoch, 'allocatorUrl', url);
  const positionsUrl = read(epoch, 'positionsUrl', url);
  const indexerUrl = read(agglayer, 'indexerUrl', url);
  const midenDomain = read(usdcx, 'midenDomain', domain);
  const attestationUrl = read(usdcx, 'attestationUrl', url);
  const irisUrl = read(usdcx, 'irisUrl', url);
  const swap = section(body.swap);
  const etaUrl = read(swap, 'etaUrl', url);
  const oneClickConfig =
    swap.oneClick === undefined
      ? undefined
      : read(swap, 'oneClick', value => oneClick(value, network, allowLocalHttp, allowOneClickLocalE2E));
  const supportedEvmChains = supportedChains(body.supportedEvmChains, url);
  // A route without the provider values it runs on is left out; so is a token output nothing declares.
  for (const { bridges } of Object.values(supportedEvmChains)) {
    if (bridges.epoch && (!allocatorUrl || !positionsUrl)) delete bridges.epoch;
    if (bridges.agglayer && !indexerUrl) delete bridges.agglayer;
    if (bridges.usdcx && (midenDomain === undefined || !attestationUrl || !irisUrl)) delete bridges.usdcx;
    // Not Object.hasOwn: Safari before 15.4 lacks it and the build ships no polyfill.
    for (const token of Object.values(bridges.epoch?.tokens ?? {}))
      token.outputs = token.outputs.filter(name => Object.prototype.hasOwnProperty.call(outputs, name));
  }
  const guardians = readGuardians(body.guardians, url);
  const limits = readLimits(body.limits);
  const geo = readGeoBlocks(body.geo, invalid);
  const features = section(body.features);
  const earnEnabled = featureSwitch(features, 'earn');
  const earn = readEarn(body.earn, earnEnabled, body.supportedEvmChains);
  const arcade = readArcade(body.arcade, featureSwitch(features, 'arcadeGcPurchase'));
  const backup = readBackup(body.backup, featureSwitch(features, 'encryptedBackup'));
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
    features: {
      earn: earnEnabled,
      nearIntents: featureSwitch(features, 'nearIntents'),
      ...Object.fromEntries(
        ['fastBridge', 'bridgeIn', 'bridgeOut', 'arcadeGcPurchase', 'encryptedBackup']
          .filter(name => features[name] !== undefined)
          .map(name => [name, featureSwitch(features, name)])
      )
    },
    mainnetCountdown: readCountdown(body.mainnetCountdown),
    ...(limits === undefined ? {} : { limits }),
    swap: {
      ...(etaUrl === undefined ? {} : { etaUrl }),
      ...(oneClickConfig === undefined ? {} : { oneClick: oneClickConfig })
    },
    ...(guardians === undefined ? {} : { guardians }),
    ...(earn === undefined ? {} : { earn }),
    ...(arcade === undefined ? {} : { arcade }),
    ...(backup === undefined ? {} : { backup }),
    ...(geo === undefined ? {} : { geo })
  };
}

/** The Miden faucet an Epoch token settles into: its first output, as the Epoch provider lists it. */
export function epochTokenFaucetId(config: BridgeConfig, token: EpochTokenConfig | undefined): string | undefined {
  const name = token?.outputs[0];
  return name === undefined ? undefined : config['bridge-providers'].epoch.outputs?.[name]?.faucetId;
}

/** The Earn collateral faucet: the faucet the first Epoch route's USDC settles into. */
export function epochCollateralFaucetId(config: BridgeConfig): string | undefined {
  const epoch = Object.values(config.supportedEvmChains).find(chain => chain.bridges.epoch)?.bridges.epoch;
  return epochTokenFaucetId(config, epoch?.tokens.USDC);
}

/**
 * The document for `network`, or null when it is malformed or names another network. Strict on known fields,
 * blind to unknown ones: a chain, route, token or output this build does not know or cannot complete is left out.
 * URLs come back without a trailing slash; addresses and ids in lowercase.
 */
export function parseBridgeConfig(
  body: unknown,
  network: string,
  options: { allowLocalHttp?: boolean; allowOneClickLocalE2E?: boolean } = {}
): BridgeConfig | null {
  try {
    return readConfig(body, network, options.allowLocalHttp === true, options.allowOneClickLocalE2E === true);
  } catch {
    return null;
  }
}
