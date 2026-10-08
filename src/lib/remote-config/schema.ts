import { isRecord } from 'lib/update/guards';
import { SUPPORTED_CHAINS } from 'lib/walletconnect/config';

/** The per-feature switches a document carries; each stops new starts only. */
export const BRIDGE_SWITCHES = ['earn', 'fastBridge', 'bridgeIn', 'bridgeOut'] as const;
export type BridgeSwitch = (typeof BRIDGE_SWITCHES)[number];

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
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MIDEN_ACCOUNT_ID = /^0x[0-9a-fA-F]{30}$/;
// An RFC 3339 timestamp in UTC, such as 2026-10-26T00:00:00Z: one spelling, so every wallet reads the same instant.
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const LOCAL_HTTP_HOSTS = ['127.0.0.1', 'localhost'];

// Each check throws on a violation and parseBridgeConfig catches once: one bad known field rejects the document.
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

function utcTimestamp(value: unknown): number {
  if (typeof value !== 'string' || !UTC_TIMESTAMP.test(value)) return invalid();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? invalid() : parsed;
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
  const countdown = section(body.mainnetCountdown);
  const chain = read(evm, 'chainId', chainId);
  const l1Bridge = read(agglayer, 'l1Bridge', evmAddress);
  const midenBridge = read(agglayer, 'midenBridge', midenAccountId);
  const indexerUrl = read(agglayer, 'indexerUrl', url);
  const allocatorUrl = read(epoch, 'allocatorUrl', url);
  const positionsUrl = read(epoch, 'positionsUrl', url);
  const midenUsdcFaucet = read(epoch, 'midenUsdcFaucet', midenAccountId);
  const evmUsdc = read(epoch, 'evmUsdc', evmAddress);
  const protocol = read(epoch, 'earnProtocol', earnProtocol);
  const launchAt = read(countdown, 'launchAt', utcTimestamp);
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
    mainnetCountdown: {
      enabled: featureSwitch(countdown, 'enabled'),
      ...(launchAt === undefined ? {} : { launchAt })
    }
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
