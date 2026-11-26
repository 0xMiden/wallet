// Parse and check the Worker variables. The parse is strict: an unknown field, a bad value or a missing
// field throws ConfigError. Every address and hash leaves the parse in lower case.
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

export interface ChainConfig {
  chainId: number;
  calibur: CaliburConfig;
  feeRecipient: Hex | null;
  /**
   * The fee of each token, in base units, keyed by token address in config order. The zero address is the native
   * coin. It is empty when the config has no `fees`.
   */
  fees: ReadonlyMap<Hex, bigint>;
  /** The addresses that a call of a batch can go to, in config order. Null when any address is allowed. */
  allowedTargets: readonly Hex[] | null;
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

function parseChain(key: string, value: unknown, gasMode: GasMode): ChainConfig {
  const path = `RELAY_CONFIG.chains.${key}`;
  const chainId = Number(key);
  if (!CHAIN_ID.test(key) || !Number.isSafeInteger(chainId)) fail(path, 'must have a positive decimal chain id key');
  const fields = shape(value, path, ['calibur'], ['feeRecipient', 'fees', 'allowedTargets']);
  const feeRecipient = fields.feeRecipient === undefined ? null : address(fields.feeRecipient, `${path}.feeRecipient`);
  const fees = parseFees(fields.fees, `${path}.fees`);
  if (gasMode === 'deduct' && feeRecipient === null) {
    fail(`${path}.feeRecipient`, 'is required when GAS_MODE is deduct');
  }
  if (gasMode === 'deduct' && fees.size === 0) fail(`${path}.fees`, 'must name a token when GAS_MODE is deduct');
  return {
    chainId,
    calibur: parseCalibur(fields.calibur, `${path}.calibur`),
    feeRecipient,
    fees,
    allowedTargets: parseTargets(fields.allowedTargets, `${path}.allowedTargets`)
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
