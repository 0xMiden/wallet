// Parse and check the Worker variables. The parse is strict: an unknown field, a bad value or a missing
// field throws ConfigError. Every address and hash leaves the parse in lower case.
//
// All chains use one Calibur pin and one fee recipient, at the top of RELAY_CONFIG. The Worker serves each chain that
// has an `RPC_URL_<chainId>` secret, and no other chain. The optional `chains` object holds only the values that are
// different on each chain: the price symbol of the native coin, the fee tokens (token addresses) and the allowed
// targets (contract addresses).
import { notConfigured } from './errors';
import { isRecord } from './http';
import { ParseError, address, fail, shape, type Hex } from './parse';
import type { Env } from './types';

export type { Hex } from './parse';

/**
 * `sponsor`: the relayer pays the gas. `deduct`: each batch pays a fee to `feeRecipient`. The fee is the simulated gas
 * cost of the batch, priced in the fee token (fee.ts).
 */
export type GasMode = 'sponsor' | 'deduct';

/**
 * The price of a coin or a token against USD. `usd`: a USD stablecoin, priced at 1 USD. Any other value is a market
 * symbol of the price sources (prices.ts), for example `ETHUSDT`: 5 to 20 characters of `A-Z0-9`.
 */
export type PriceSymbol = string;

/** The symbol of a USD stablecoin. Its price is 1 USD, and the Worker asks no price source for it. */
export const USD_SYMBOL = 'usd';

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
   * The price symbol of the native coin, or null when the entry has none. `deduct` mode needs it on each served chain.
   */
  nativePrice: PriceSymbol | null;
  /**
   * The ERC-20 tokens that the chain takes a fee in, keyed by token address in config order, with the price symbol of
   * each. The native coin is not in the map: in `deduct` mode it is always a fee token, and it needs no price.
   */
  feeTokens: ReadonlyMap<Hex, PriceSymbol>;
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
/** A market symbol of the price sources, for example `ETHUSDT`. */
const MARKET_SYMBOL = /^[A-Z0-9]{5,20}$/;
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

/** A price symbol: `usd`, or 5 to 20 characters of `A-Z0-9`. */
function priceSymbol(value: unknown, path: string): PriceSymbol {
  if (value === USD_SYMBOL || (typeof value === 'string' && MARKET_SYMBOL.test(value))) return value;
  fail(path, 'must be "usd" or a market symbol of 5 to 20 characters A-Z and 0-9');
}

/**
 * The `feeTokens` object: ERC-20 token address to its price symbol. Absent means no ERC-20 fee token. The zero address
 * is refused, because the native coin is always a fee token in `deduct` mode.
 */
function parseFeeTokens(value: unknown, path: string): Map<Hex, PriceSymbol> {
  const tokens = new Map<Hex, PriceSymbol>();
  if (value === undefined) return tokens;
  if (!isRecord(value)) fail(path, 'must be an object');
  for (const [key, entry] of Object.entries(value)) {
    const token = address(key, `${path}.${key}`);
    if (tokens.has(token)) fail(`${path}.${key}`, 'repeats a token address');
    tokens.set(token, priceSymbol(entry, `${path}.${key}`));
  }
  return tokens;
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
  nativePrice: PriceSymbol | null;
  feeTokens: Map<Hex, PriceSymbol>;
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
  const fields = shape(value, path, [], ['nativePrice', 'feeTokens', 'allowedTargets']);
  return [
    chainId,
    {
      nativePrice: fields.nativePrice === undefined ? null : priceSymbol(fields.nativePrice, `${path}.nativePrice`),
      feeTokens: parseFeeTokens(fields.feeTokens, `${path}.feeTokens`),
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
 * recipient, and the native price, the fee tokens and the allowed targets of its `chains` entry. A served chain
 * without an entry gets no price, no fee token and no target list. In `deduct` mode each served chain needs an entry
 * with `nativePrice`. The parse checks an entry of a chain that is not served, but does not keep it: that chain is not
 * supported.
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
      const nativePrice = entry?.nativePrice ?? null;
      if (gasMode === 'deduct' && nativePrice === null) {
        fail(`RELAY_CONFIG.chains.${chainId}.nativePrice`, 'is required when GAS_MODE is deduct');
      }
      chains.set(chainId, {
        chainId,
        calibur,
        feeRecipient,
        nativePrice,
        feeTokens: entry?.feeTokens ?? new Map<Hex, PriceSymbol>(),
        allowedTargets: entry?.allowedTargets ?? null
      });
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
