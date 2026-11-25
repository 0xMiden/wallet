// Parse and check the Worker variables. The parse is strict: an unknown field, a bad value or a missing
// field throws ConfigError. Every address and hash leaves the parse in lower case.
import { isRecord } from './http';
import type { Env } from './types';

export type Hex = `0x${string}`;

/** `sponsor`: the relayer pays the gas. `deduct`: each token pays a fixed fee to `feeRecipient`. */
export type GasMode = 'sponsor' | 'deduct';

export interface CaliburConfig {
  address: Hex;
  /** The hash of the Calibur runtime code. */
  runtimeHash: Hex;
  domainName: string;
  domainVersion: string;
}

export interface AgglayerConfig {
  bridgeAddress: Hex;
  midenNetworkId: number;
  forceUpdateGlobalExitRoot: boolean;
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
  agglayer: AgglayerConfig | null;
  /** Keyed by token address. The zero address is the native coin. */
  tokens: ReadonlyMap<Hex, TokenPolicy>;
}

export interface RelayConfig {
  gasMode: GasMode;
  allowedOrigins: ReadonlySet<string>;
  chains: ReadonlyMap<number, ChainConfig>;
}

export class ConfigError extends Error {}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
/** A decimal integer of at most 78 digits, so the BigInt parse stays small. 2^256 has 78 digits. */
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
const CHAIN_ID = /^[1-9][0-9]*$/;
const ZERO_ADDRESS: Hex = `0x${'0'.repeat(40)}`;
const UINT256_LIMIT = 2n ** 256n;
const UINT32_MAX = 2 ** 32 - 1;

function fail(path: string, rule: string): never {
  throw new ConfigError(`${path} ${rule}.`);
}

/** Return the object when it has every required field and no field outside the two lists. */
function shape(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> {
  if (!isRecord(value)) fail(path, 'must be an object');
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'is missing');
  }
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) fail(`${path}.${key}`, 'is not a known field');
  }
  return value;
}

function address(value: unknown, path: string, allowZero = false): Hex {
  if (typeof value !== 'string' || !ADDRESS.test(value)) fail(path, 'must be a 20-byte hex address');
  const hex: Hex = `0x${value.slice(2).toLowerCase()}`;
  if (!allowZero && hex === ZERO_ADDRESS) fail(path, 'must not be the zero address');
  return hex;
}

function hash(value: unknown, path: string): Hex {
  if (typeof value !== 'string' || !HASH.test(value)) fail(path, 'must be a 32-byte hex hash');
  return `0x${value.slice(2).toLowerCase()}`;
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(path, 'must be a non-empty string');
  return value;
}

/** A decimal string below 2^256. */
function amount(value: unknown, path: string): bigint {
  if (typeof value !== 'string' || !DECIMAL.test(value)) fail(path, 'must be a decimal integer string');
  const parsed = BigInt(value);
  if (parsed >= UINT256_LIMIT) fail(path, 'must be below 2^256');
  return parsed;
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

function parseAgglayer(value: unknown, path: string): AgglayerConfig {
  const fields = shape(value, path, ['bridgeAddress', 'midenNetworkId', 'forceUpdateGlobalExitRoot']);
  const { midenNetworkId, forceUpdateGlobalExitRoot } = fields;
  if (typeof midenNetworkId !== 'number' || !Number.isInteger(midenNetworkId)) {
    fail(`${path}.midenNetworkId`, 'must be an integer');
  }
  if (midenNetworkId < 0 || midenNetworkId > UINT32_MAX) fail(`${path}.midenNetworkId`, 'must be in 0..2^32-1');
  if (typeof forceUpdateGlobalExitRoot !== 'boolean') fail(`${path}.forceUpdateGlobalExitRoot`, 'must be a boolean');
  return {
    bridgeAddress: address(fields.bridgeAddress, `${path}.bridgeAddress`),
    midenNetworkId,
    forceUpdateGlobalExitRoot
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
  const fields = shape(value, path, ['calibur', 'tokens'], ['feeRecipient', 'agglayer']);
  const feeRecipient = fields.feeRecipient === undefined ? null : address(fields.feeRecipient, `${path}.feeRecipient`);
  if (gasMode === 'deduct' && feeRecipient === null)
    fail(`${path}.feeRecipient`, 'is required when GAS_MODE is deduct');
  return {
    chainId,
    calibur: parseCalibur(fields.calibur, `${path}.calibur`),
    feeRecipient,
    agglayer: fields.agglayer === undefined ? null : parseAgglayer(fields.agglayer, `${path}.agglayer`),
    tokens: parseTokens(fields.tokens, `${path}.tokens`, gasMode)
  };
}

export function parseGasMode(value: string | undefined): GasMode {
  switch (value) {
    case 'sponsor':
    case 'deduct':
      return value;
    default:
      return fail('GAS_MODE', 'must be sponsor or deduct');
  }
}

/** The exact allowed origins. A wildcard is refused. */
export function parseOrigins(allowedOrigins: string | undefined): Set<string> {
  let values: unknown;
  try {
    values = JSON.parse(allowedOrigins ?? '[]');
  } catch {
    fail('ALLOWED_ORIGINS', 'must be JSON');
  }
  if (!Array.isArray(values)) fail('ALLOWED_ORIGINS', 'must be a JSON array');
  const origins = new Set<string>();
  values.forEach((value: unknown) => {
    if (typeof value !== 'string' || !value || value.includes('*')) fail('ALLOWED_ORIGINS', 'must hold exact origins');
    origins.add(value);
  });
  return origins;
}

export function parseChains(relayConfig: string | undefined, gasMode: GasMode): Map<number, ChainConfig> {
  let value: unknown;
  try {
    value = JSON.parse(relayConfig ?? '');
  } catch {
    fail('RELAY_CONFIG', 'must be JSON');
  }
  const fields = shape(value, 'RELAY_CONFIG', ['chains']);
  if (!isRecord(fields.chains)) fail('RELAY_CONFIG.chains', 'must be an object');
  const chains = new Map<number, ChainConfig>();
  for (const [key, chain] of Object.entries(fields.chains)) {
    const parsed = parseChain(key, chain, gasMode);
    chains.set(parsed.chainId, parsed);
  }
  return chains;
}

/** Parse every variable of the Worker. Throw ConfigError on the first bad value. */
export function parseConfig(env: Env): RelayConfig {
  const gasMode = parseGasMode(env.GAS_MODE);
  return { gasMode, allowedOrigins: parseOrigins(env.ALLOWED_ORIGINS), chains: parseChains(env.RELAY_CONFIG, gasMode) };
}
