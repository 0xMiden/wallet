import { KNOWN_SYMBOLS } from 'lib/prices/constant';
import { isRecord } from 'lib/update/guards';
import { SUPPORTED_CHAINS } from 'lib/walletconnect/config';

/** The per-feature switches a document carries; each stops new starts only. */
export const BRIDGE_SWITCHES = ['earn', 'fastBridge', 'bridgeIn', 'bridgeOut'] as const;
export type BridgeSwitch = (typeof BRIDGE_SWITCHES)[number];

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

/** The picker pings every listed Guardian operator, so the list is bounded. */
export const MAX_GUARDIANS = 16;
export const MAX_GUARDIAN_ID_LENGTH = 32;
/** The longest name, operator or location the wallet shows. */
export const MAX_GUARDIAN_LABEL_LENGTH = 48;
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

export interface BridgeConfig {
  network: string;
  version: number;
  evm: { chainId?: number };
  agglayer: { l1Bridge?: EvmAddress; midenBridge?: string; indexerUrl?: string };
  epoch: {
    allocatorUrl?: string;
    positionsUrl?: string;
    /** '0x' + 30 lowercase hex. */
    midenUsdcFaucet?: string;
    evmUsdc?: EvmAddress;
    earnProtocol?: EarnProtocol;
  };
  features: Record<BridgeSwitch, boolean>;
  /** Always set by the parser; optional in the type so a stand-in config built by a test needs none. */
  mainnetCountdown?: MainnetCountdownConfig;
  /** Always set by the parser; optional in the type for the same reason. Absent reads as no swap tokens. */
  swap?: SwapConfig;
  /**
   * The network's Guardian operators in picker order, the first being the default. Never empty. Absent means the
   * document names none, and the wallet uses the list it ships with (`lib/miden-chain/guardian-registry`).
   */
  guardians?: GuardianConfig[];
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MIDEN_ACCOUNT_ID = /^0x[0-9a-fA-F]{30}$/;
const TOKEN_SYMBOL = /^[A-Z]{1,6}$/;
// Lower-case letters and digits in groups joined by single hyphens.
const GUARDIAN_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// C0 controls, DEL and C1 controls: none belongs in a line of text the wallet shows.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
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

// An unsupported chain or protocol is not an error: a newer document may name one this build lacks, and the
// features that need it read as not configured.
function chainId(value: unknown): number | undefined {
  if (!isPositiveSafeInteger(value)) return invalid();
  return SUPPORTED_EVM_CHAIN_IDS.includes(value) ? value : undefined;
}

function earnProtocol(value: unknown): EarnProtocol | undefined {
  if (typeof value !== 'string') return invalid();
  return SUPPORTED_EARN_PROTOCOLS.find(protocol => protocol === value);
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

function guardianId(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_GUARDIAN_ID_LENGTH || !GUARDIAN_ID.test(value)) return invalid();
  return RESERVED_GUARDIAN_IDS.includes(value) ? invalid() : value;
}

// A line of text the wallet shows as written: 1 to 48 characters, no control character, no space at either end.
function guardianLabel(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_GUARDIAN_LABEL_LENGTH) return invalid();
  return value !== value.trim() || CONTROL_CHARACTER.test(value) ? invalid() : value;
}

function readGuardian(value: unknown, url: (value: unknown) => string): GuardianConfig {
  if (!isRecord(value)) return invalid();
  return {
    id: guardianId(value.id),
    name: guardianLabel(value.name),
    operatedBy: guardianLabel(value.operatedBy),
    location: guardianLabel(value.location),
    endpoint: url(value.endpoint)
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
  const url = (value: unknown) => baseUrl(value, allowLocalHttp);
  const evm = section(body.evm);
  const agglayer = section(body.agglayer);
  const epoch = section(body.epoch);
  const features = section(body.features);
  const swap = section(body.swap);
  const etaUrl = read(swap, 'etaUrl', url);
  const chain = read(evm, 'chainId', chainId);
  const l1Bridge = read(agglayer, 'l1Bridge', evmAddress);
  const midenBridge = read(agglayer, 'midenBridge', midenAccountId);
  const indexerUrl = read(agglayer, 'indexerUrl', url);
  const allocatorUrl = read(epoch, 'allocatorUrl', url);
  const positionsUrl = read(epoch, 'positionsUrl', url);
  const midenUsdcFaucet = read(epoch, 'midenUsdcFaucet', midenAccountId);
  const evmUsdc = read(epoch, 'evmUsdc', evmAddress);
  const protocol = read(epoch, 'earnProtocol', earnProtocol);
  const guardians = readGuardians(body.guardians, url);
  return {
    network,
    version,
    evm: chain === undefined ? {} : { chainId: chain },
    agglayer: {
      ...(l1Bridge === undefined ? {} : { l1Bridge }),
      ...(midenBridge === undefined ? {} : { midenBridge }),
      ...(indexerUrl === undefined ? {} : { indexerUrl })
    },
    epoch: {
      ...(allocatorUrl === undefined ? {} : { allocatorUrl }),
      ...(positionsUrl === undefined ? {} : { positionsUrl }),
      ...(midenUsdcFaucet === undefined ? {} : { midenUsdcFaucet }),
      ...(evmUsdc === undefined ? {} : { evmUsdc }),
      ...(protocol === undefined ? {} : { earnProtocol: protocol })
    },
    features: {
      earn: featureSwitch(features, 'earn'),
      fastBridge: featureSwitch(features, 'fastBridge'),
      bridgeIn: featureSwitch(features, 'bridgeIn'),
      bridgeOut: featureSwitch(features, 'bridgeOut')
    },
    mainnetCountdown: readCountdown(body.mainnetCountdown),
    swap: { tokens: readSwapTokens(swap.tokens), ...(etaUrl === undefined ? {} : { etaUrl }) },
    ...(guardians === undefined ? {} : { guardians })
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
