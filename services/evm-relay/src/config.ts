// Parse and check the Worker variables. The parse is strict: an unknown field, a bad value or a missing
// field throws ConfigError. Every address and hash leaves the parse in lower case.
import { notConfigured } from './errors';
import { isRecord } from './http';
import { parseKinds, type KindConfigs } from './kinds';
import { ParseError, address, amount, fail, shape, type Hex } from './parse';
import type { Env } from './types';

export type { Hex } from './parse';

/** `sponsor`: the relayer pays the gas. `deduct`: each token pays a fixed fee to `feeRecipient`. */
export type GasMode = 'sponsor' | 'deduct';

export interface CaliburConfig {
  address: Hex;
  /** The hash of the Calibur runtime code. */
  runtimeHash: Hex;
  domainName: string;
  domainVersion: string;
}

/** The amounts of one token, in base units. */
export interface TokenPolicy {
  minAmount: bigint;
  fee: bigint;
}

export interface ChainConfig {
  chainId: number;
  calibur: CaliburConfig;
  feeRecipient: Hex | null;
  /** The config of each relay kind that the chain supports. It can be empty. */
  kinds: KindConfigs;
  /** Keyed by token address. The zero address is the native coin. */
  tokens: ReadonlyMap<Hex, TokenPolicy>;
}

export interface RelayConfig {
  gasMode: GasMode;
  allowedOrigins: ReadonlySet<string>;
  chains: ReadonlyMap<number, ChainConfig>;
}

export class ConfigError extends Error {}

const HASH = /^0x[0-9a-fA-F]{64}$/;
const CHAIN_ID = /^[1-9][0-9]*$/;

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

function parseToken(value: unknown, path: string, gasMode: GasMode): TokenPolicy {
  const fields = shape(value, path, ['minAmount', 'fee']);
  const minAmount = amount(fields.minAmount, `${path}.minAmount`);
  const fee = amount(fields.fee, `${path}.fee`);
  if (minAmount === 0n) fail(`${path}.minAmount`, 'must be above 0');
  if (gasMode === 'deduct' && fee === 0n) fail(`${path}.fee`, 'must be above 0 when GAS_MODE is deduct');
  if (gasMode === 'deduct' && minAmount <= fee) {
    fail(`${path}.minAmount`, 'must be above the fee when GAS_MODE is deduct');
  }
  return { minAmount, fee };
}

function parseTokens(value: unknown, path: string, gasMode: GasMode): Map<Hex, TokenPolicy> {
  if (!isRecord(value)) fail(path, 'must be an object');
  const tokens = new Map<Hex, TokenPolicy>();
  for (const [key, entry] of Object.entries(value)) {
    const token = address(key, `${path}.${key}`, true);
    if (tokens.has(token)) fail(`${path}.${key}`, 'repeats a token address');
    tokens.set(token, parseToken(entry, `${path}.${key}`, gasMode));
  }
  return tokens;
}

function parseChain(key: string, value: unknown, gasMode: GasMode): ChainConfig {
  const path = `RELAY_CONFIG.chains.${key}`;
  const chainId = Number(key);
  if (!CHAIN_ID.test(key) || !Number.isSafeInteger(chainId)) fail(path, 'must have a positive decimal chain id key');
  const fields = shape(value, path, ['calibur', 'kinds', 'tokens'], ['feeRecipient']);
  const feeRecipient = fields.feeRecipient === undefined ? null : address(fields.feeRecipient, `${path}.feeRecipient`);
  if (gasMode === 'deduct' && feeRecipient === null)
    fail(`${path}.feeRecipient`, 'is required when GAS_MODE is deduct');
  return {
    chainId,
    calibur: parseCalibur(fields.calibur, `${path}.calibur`),
    feeRecipient,
    kinds: parseKinds(fields.kinds, `${path}.kinds`),
    tokens: parseTokens(fields.tokens, `${path}.tokens`, gasMode)
  };
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

export function parseChains(relayConfig: string | undefined, gasMode: GasMode): Map<number, ChainConfig> {
  let value: unknown;
  try {
    value = JSON.parse(relayConfig ?? '');
  } catch {
    throw new ConfigError('RELAY_CONFIG must be JSON.');
  }
  return configured(() => {
    const fields = shape(value, 'RELAY_CONFIG', ['chains']);
    if (!isRecord(fields.chains)) fail('RELAY_CONFIG.chains', 'must be an object');
    const chains = new Map<number, ChainConfig>();
    for (const [key, chain] of Object.entries(fields.chains)) {
      const parsed = parseChain(key, chain, gasMode);
      chains.set(parsed.chainId, parsed);
    }
    return chains;
  });
}

/** Parse every variable of the Worker. Throw ConfigError on the first bad value. */
export function parseConfig(env: Env): RelayConfig {
  const gasMode = parseGasMode(env.GAS_MODE);
  return { gasMode, allowedOrigins: parseOrigins(env.ALLOWED_ORIGINS), chains: parseChains(env.RELAY_CONFIG, gasMode) };
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
