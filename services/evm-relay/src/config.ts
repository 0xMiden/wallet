// Parse and check the Worker variables. The parse is strict: an unknown field, a bad value or a missing
// field throws ConfigError. Every address and hash leaves the parse in lower case.
//
// All chains use one Calibur pin and one fee recipient, at the top of RELAY_CONFIG. The Worker serves each chain that
// has an `RPC_URL_<chainId>` secret, and no other chain. The optional `chains` object holds only the values that are
// different on each chain: the fees (token addresses) and the allowed targets (contract addresses).
import { notConfigured } from './errors';
import { isRecord } from './http';
import { ParseError, address, amount, fail, shape, type Hex } from './parse';
import type { Env } from './types';

export type { Hex } from './parse';

/** `sponsor`: the relayer pays the gas. `deduct`: each batch pays a fixed token fee to `feeRecipient`. */
export type GasMode = 'sponsor' | 'deduct';

export interface CaliburConfig {
  address: Hex;
  /** The hash of the Calibur runtime code. */
  runtimeHash: Hex;
  domainName: string;
  domainVersion: string;
}

/** The config of one served chain. `calibur` and `feeRecipient` are the shared values of RELAY_CONFIG. */
export interface ChainConfig {
  chainId: number;
  calibur: CaliburConfig;
  feeRecipient: Hex | null;
  /**
   * The fee of each token, in base units, keyed by token address in config order. The zero address is the native
   * coin. It is empty when the chain has no entry or its entry has no `fees`.
   */
  fees: ReadonlyMap<Hex, bigint>;
  /**
   * The addresses that a call of a batch can go to, in config order. Null when any address is allowed: the chain has no
   * entry, or its entry has no `allowedTargets`.
   */
  allowedTargets: readonly Hex[] | null;
}

export interface RelayConfig {
  gasMode: GasMode;
  allowedOrigins: ReadonlySet<string>;
  /** The Calibur pin of every chain. */
  calibur: CaliburConfig;
  feeRecipient: Hex | null;
  /** The chains that the Worker serves: each chain with an `RPC_URL_<chainId>` secret, in chain id order. */
  chains: ReadonlyMap<number, ChainConfig>;
}

export class ConfigError extends Error {}

const HASH = /^0x[0-9a-fA-F]{64}$/;
const CHAIN_ID = /^[1-9][0-9]*$/;
/** The prefix of the secret that holds the RPC URL of a chain. */
const RPC_URL_PREFIX = 'RPC_URL_';

/** Run a parse and report its ParseError as ConfigError. */
function configured<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ParseError) throw new ConfigError(error.message);
    throw error;
  }
}

function hash(value: unknown, path: string): Hex {
  if (typeof value !== 'string' || !HASH.test(value)) fail(path, 'must be a 32-byte hex hash');
  return `0x${value.slice(2).toLowerCase()}`;
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(path, 'must be a non-empty string');
  return value;
}

function parseCalibur(value: unknown, path: string): CaliburConfig {
  const fields = shape(value, path, ['address', 'runtimeHash', 'domainName', 'domainVersion']);
  return {
    address: address(fields.address, `${path}.address`),
    runtimeHash: hash(fields.runtimeHash, `${path}.runtimeHash`),
    domainName: text(fields.domainName, `${path}.domainName`),
    domainVersion: text(fields.domainVersion, `${path}.domainVersion`)
  };
}

/** The `fees` object: token address to a fee above 0. Absent means no fee. */
function parseFees(value: unknown, path: string): Map<Hex, bigint> {
  const fees = new Map<Hex, bigint>();
  if (value === undefined) return fees;
  if (!isRecord(value)) fail(path, 'must be an object');
  for (const [key, entry] of Object.entries(value)) {
    const token = address(key, `${path}.${key}`, true);
    if (fees.has(token)) fail(`${path}.${key}`, 'repeats a token address');
    const fee = amount(entry, `${path}.${key}`);
    if (fee === 0n) fail(`${path}.${key}`, 'must be above 0');
    fees.set(token, fee);
  }
  return fees;
}

/** The `allowedTargets` list: absent means any target, else a non-empty list of distinct non-zero addresses. */
function parseTargets(value: unknown, path: string): Hex[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0) fail(path, 'must be a non-empty array');
  const targets: Hex[] = [];
  value.forEach((entry: unknown, index) => {
    const target = address(entry, `${path}.${index}`);
    if (targets.includes(target)) fail(`${path}.${index}`, 'repeats a target address');
    targets.push(target);
  });
  return targets;
}

/** The values of `RELAY_CONFIG.chains.<chainId>`: the values that are different on each chain. */
interface ChainEntry {
  fees: Map<Hex, bigint>;
  allowedTargets: Hex[] | null;
}

/** A positive decimal chain id that is a safe integer, else null. */
function chainIdOf(key: string): number | null {
  const chainId = Number(key);
  return CHAIN_ID.test(key) && Number.isSafeInteger(chainId) ? chainId : null;
}

function parseChainEntry(key: string, value: unknown): [number, ChainEntry] {
  const path = `RELAY_CONFIG.chains.${key}`;
  const chainId = chainIdOf(key);
  if (chainId === null) fail(path, 'must have a positive decimal chain id key');
  const fields = shape(value, path, [], ['fees', 'allowedTargets']);
  return [
    chainId,
    {
      fees: parseFees(fields.fees, `${path}.fees`),
      allowedTargets: parseTargets(fields.allowedTargets, `${path}.allowedTargets`)
    }
  ];
}

/** The optional `chains` object: chain id to its entry. Absent means no entry. */
function parseChainEntries(value: unknown): Map<number, ChainEntry> {
  const entries = new Map<number, ChainEntry>();
  if (value === undefined) return entries;
  if (!isRecord(value)) fail('RELAY_CONFIG.chains', 'must be an object');
  for (const [key, entry] of Object.entries(value)) {
    const [chainId, parsed] = parseChainEntry(key, entry);
    entries.set(chainId, parsed);
  }
  return entries;
}

/**
 * The chains that the Worker serves: the chain id of each `RPC_URL_<chainId>` key of the env, in ascending order. A
 * key with this prefix and another suffix is a config error. The message does not name the key or its value.
 */
export function servedChainIds(env: Env): number[] {
  const chainIds: number[] = [];
  for (const key of Object.keys(env)) {
    if (!key.startsWith(RPC_URL_PREFIX)) continue;
    const chainId = chainIdOf(key.slice(RPC_URL_PREFIX.length));
    if (chainId === null) throw new ConfigError('Each RPC_URL_ secret must end in a positive decimal chain id.');
    chainIds.push(chainId);
  }
  return chainIds.sort((left, right) => left - right);
}

export function parseGasMode(value: string | undefined): GasMode {
  switch (value) {
    case 'sponsor':
    case 'deduct':
      return value;
    default:
      throw new ConfigError('GAS_MODE must be sponsor or deduct.');
  }
}

/** The exact allowed origins. A wildcard is refused. */
export function parseOrigins(allowedOrigins: string | undefined): Set<string> {
  let values: unknown;
  try {
    values = JSON.parse(allowedOrigins ?? '[]');
  } catch {
    throw new ConfigError('ALLOWED_ORIGINS must be JSON.');
  }
  if (!Array.isArray(values)) throw new ConfigError('ALLOWED_ORIGINS must be a JSON array.');
  const origins = new Set<string>();
  values.forEach((value: unknown) => {
    if (typeof value !== 'string' || !value || value.includes('*')) {
      throw new ConfigError('ALLOWED_ORIGINS must hold exact origins.');
    }
    origins.add(value);
  });
  return origins;
}

/** The parsed `RELAY_CONFIG`: the shared values, and the config of each served chain. */
export interface ParsedRelayConfig {
  calibur: CaliburConfig;
  feeRecipient: Hex | null;
  chains: Map<number, ChainConfig>;
}

/**
 * Parse `RELAY_CONFIG` for the served chains `chainIds`. Each served chain gets the one Calibur pin and the one fee
 * recipient, and the fees and the allowed targets of its `chains` entry. A served chain without an entry gets no fee
 * and no target list. The parse checks an entry of a chain that is not served, but does not keep it: that chain is
 * not supported.
 */
export function parseRelayConfig(
  relayConfig: string | undefined,
  gasMode: GasMode,
  chainIds: readonly number[]
): ParsedRelayConfig {
  let value: unknown;
  try {
    value = JSON.parse(relayConfig ?? '');
  } catch {
    throw new ConfigError('RELAY_CONFIG must be JSON.');
  }
  return configured(() => {
    const fields = shape(value, 'RELAY_CONFIG', ['calibur'], ['feeRecipient', 'chains']);
    const calibur = parseCalibur(fields.calibur, 'RELAY_CONFIG.calibur');
    const feeRecipient =
      fields.feeRecipient === undefined ? null : address(fields.feeRecipient, 'RELAY_CONFIG.feeRecipient');
    const entries = parseChainEntries(fields.chains);
    if (gasMode === 'deduct' && feeRecipient === null) {
      fail('RELAY_CONFIG.feeRecipient', 'is required when GAS_MODE is deduct');
    }
    const chains = new Map<number, ChainConfig>();
    for (const chainId of chainIds) {
      const entry = entries.get(chainId);
      const fees = entry?.fees ?? new Map<Hex, bigint>();
      if (gasMode === 'deduct' && fees.size === 0) {
        fail(`RELAY_CONFIG.chains.${chainId}.fees`, 'must name a token when GAS_MODE is deduct');
      }
      chains.set(chainId, { chainId, calibur, feeRecipient, fees, allowedTargets: entry?.allowedTargets ?? null });
    }
    return { calibur, feeRecipient, chains };
  });
}

/** Parse every variable of the Worker. Throw ConfigError on the first bad value. */
export function parseConfig(env: Env): RelayConfig {
  const gasMode = parseGasMode(env.GAS_MODE);
  const allowedOrigins = parseOrigins(env.ALLOWED_ORIGINS);
  return { gasMode, allowedOrigins, ...parseRelayConfig(env.RELAY_CONFIG, gasMode, servedChainIds(env)) };
}

/** The config of a route. A variable that does not parse gives `503 service_unavailable`. */
export function routeConfig(env: Env): RelayConfig {
  try {
    return parseConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) throw notConfigured();
    throw error;
  }
}
