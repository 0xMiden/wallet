import { isRecord } from 'lib/update/guards';
import { SUPPORTED_CHAINS } from 'lib/walletconnect/config';

import { evmChainSlug } from './chains';
import { type GeoBlocks, readGeoBlocks } from './geo';

/** The per-feature switches a document carries; each stops new starts only. */
export const BRIDGE_SWITCHES: readonly BridgeSwitch[] = ['earn'];
export type BridgeSwitch = 'earn';

export interface SwapConfig {
  /**
   * The DEX solver's base URL. The swap registry is its `/v2/pairs` (see `swap-pairs.ts`), and
   * `lib/miden/swap/quote` appends `/v2/pair-price` and `/v2/swap-eta` to it; absent means no swap
   * tokens and no quotes.
   */
  etaUrl?: string;
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

/** Earn protocols the Earn code supports. */
export const SUPPORTED_EARN_PROTOCOLS = ['dummy-lending'] as const;
export type EarnProtocol = (typeof SUPPORTED_EARN_PROTOCOLS)[number];
/** The lender key Epoch's positions service names each protocol by; it also leads the protocol's market uids. */
export const EARN_LENDER_KEYS: Readonly<Record<EarnProtocol, string>> = { 'dummy-lending': 'DUMMY_LENDING' };

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
  features: { earn: boolean; fastBridge?: boolean; bridgeIn?: boolean; bridgeOut?: boolean };
  /**
   * Places where a feature must not start. Only the "yes" answers are kept. Absent means no place
   * blocks the feature. A withdrawal of an existing Earn position is not a start.
   */
  geo?: GeoBlocks;
  /**
   * Only there when the document sets `onboarding.inviteOnly`. True: Welcome shows the invite-only
   * way in directly. False or absent: Welcome shows the create and recover flows, and the logo taps
   * unlock the invite-only way in.
   */
  onboarding?: { inviteOnly: boolean };
  mainnetCountdown?: MainnetCountdownConfig;
  swap?: SwapConfig;
  /**
   * The network's Guardian operators in picker order, the first being the default. Never empty. Absent means the
   * document names none, and the wallet uses the list it ships with (`lib/miden-chain/guardian-registry`).
   */
  guardians?: GuardianConfig[];
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MIDEN_ACCOUNT_ID = /^0x[0-9a-fA-F]{30}$/;
// Lower-case letters and digits in groups joined by single hyphens.
const GUARDIAN_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// C0 controls, DEL and C1 controls: none belongs in a line of text the wallet shows.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
// An RFC 3339 timestamp in UTC, such as 2026-10-26T00:00:00Z: one spelling, so every wallet reads the same instant.
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const LOCAL_HTTP_HOSTS = ['127.0.0.1', 'localhost'];

// Each check throws on a violation and parseBridgeConfig catches once: one bad known field rejects the document.
// What this build does not know or cannot complete (a newer chain, route, token or output) is left out instead, so
// only its own routes go unavailable. mainnetCountdown, which only drives a banner, is off when malformed.
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
  if (!Array.isArray(value)) return invalid();
  const names = value.map((name: ConfigValue) => (typeof name === 'string' ? name : invalid()));
  if (new Set(names).size !== names.length) return invalid();
  return names;
}

// Undefined for a route that lists no token this build knows.
function epochChain(value: ConfigValue): EpochChainConfig | undefined {
  const bridge = section(value);
  const routeSwitches = switches(bridge);
  const tokens = section(bridge.tokens);
  if (tokens.USDC === undefined) return undefined;
  const token = section(tokens.USDC);
  return {
    ...routeSwitches,
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

function supportedChains(value: ConfigValue): Record<string, SupportedEvmChainConfig> {
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
    const agglayer = read(bridges, 'agglayer', agglayerChain);
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

function readConfig(body: unknown, network: string, allowLocalHttp: boolean): BridgeConfig {
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
  const inviteOnly = read(section(body.onboarding), 'inviteOnly', requiredBoolean);
  const allocatorUrl = read(epoch, 'allocatorUrl', url);
  const positionsUrl = read(epoch, 'positionsUrl', url);
  const indexerUrl = read(agglayer, 'indexerUrl', url);
  const midenDomain = read(usdcx, 'midenDomain', domain);
  const attestationUrl = read(usdcx, 'attestationUrl', url);
  const irisUrl = read(usdcx, 'irisUrl', url);
  const swap = section(body.swap);
  const etaUrl = read(swap, 'etaUrl', url);
  const supportedEvmChains = supportedChains(body.supportedEvmChains);
  // A route without the provider values it runs on is left out; so is a token output nothing declares.
  for (const { bridges } of Object.values(supportedEvmChains)) {
    if (bridges.epoch && (!allocatorUrl || !positionsUrl)) delete bridges.epoch;
    if (bridges.agglayer && !indexerUrl) delete bridges.agglayer;
    if (bridges.usdcx && (midenDomain === undefined || !attestationUrl || !irisUrl)) delete bridges.usdcx;
    const usdc = bridges.epoch?.tokens.USDC;
    // Not Object.hasOwn: Safari before 15.4 lacks it and the build ships no polyfill.
    if (usdc) usdc.outputs = usdc.outputs.filter(name => Object.prototype.hasOwnProperty.call(outputs, name));
  }
  const guardians = readGuardians(body.guardians, url);
  const geo = readGeoBlocks(body.geo, invalid);
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
      earn: featureSwitch(section(body.features), 'earn'),
      ...Object.fromEntries(
        ['fastBridge', 'bridgeIn', 'bridgeOut']
          .filter(name => section(body.features)[name] !== undefined)
          .map(name => [name, featureSwitch(section(body.features), name)])
      )
    },
    mainnetCountdown: readCountdown(body.mainnetCountdown),
    swap: etaUrl === undefined ? {} : { etaUrl },
    ...(guardians === undefined ? {} : { guardians }),
    ...(inviteOnly === undefined ? {} : { onboarding: { inviteOnly } }),
    ...(geo === undefined ? {} : { geo })
  };
}

/** The Earn collateral faucet: the output the Epoch USDC token declares first, as the Epoch provider lists it. */
export function epochCollateralFaucetId(config: BridgeConfig): string | undefined {
  const epoch = Object.values(config.supportedEvmChains).find(chain => chain.bridges.epoch)?.bridges.epoch;
  const name = epoch?.tokens.USDC?.outputs[0];
  return name === undefined ? undefined : config['bridge-providers'].epoch.outputs?.[name]?.faucetId;
}

/**
 * The document for `network`, or null when it is malformed or names another network. Strict on known fields,
 * blind to unknown ones: a chain, route, token or output this build does not know or cannot complete is left out.
 * URLs come back without a trailing slash; addresses and ids in lowercase.
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
