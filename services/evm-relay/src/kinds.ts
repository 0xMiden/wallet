// The registry of relay kinds. Each kind is one entry of RELAY_KINDS: it parses its config in RELAY_CONFIG and the
// `params` of a relay request, and it builds the calls of the batch. The routes and the core modules use the
// registry and never name a kind. A new kind adds an entry to KindTypes and one to RELAY_KINDS.
import { isRecord } from './http';
import { address, amount, fail, shape, type Hex } from './parse';
import {
  MIDEN_ACCOUNT_HEX_PATTERN,
  buildAgglayerDepositCalls,
  type AgglayerDepositConfig,
  type BatchCall,
  type RelayFee,
  type RelayKind
} from '../../../src/lib/evm-relay/batch';

const UINT32_MAX = 2 ** 32 - 1;

/** The behaviour of one relay kind. `Config` is its entry in RELAY_CONFIG and `Params` the `params` of a request. */
export interface KindHandler<Config, Params> {
  /** Parse the config of the kind. Throws ParseError. */
  parseConfig(value: unknown, path: string): Config;
  /** Parse the `params` of a relay request. Throws ParseError. */
  parseParams(value: unknown, path: string): Params;
  /** The token that the batch takes from the address. The zero address is the native coin. */
  tokenOf(params: Params): Hex;
  /** The fee in the token, in base units. */
  feeOf(params: Params): bigint;
  /** The full deposit in the token: the bridged amount and the fee. */
  depositOf(params: Params): bigint;
  /** The calls of the batch. `feeRecipient` is null in sponsor mode. Throws when a value is not valid. */
  buildCalls(config: Config, params: Params, feeRecipient: Hex | null): BatchCall[];
}

/** The `params` of an Agglayer deposit request. */
export interface AgglayerDepositRequest {
  token: Hex;
  /** The bridged amount, after the fee. */
  amount: bigint;
  /** `0x` and 30 hex characters, lower case. */
  midenAccountHex: string;
  /** The fee. It is 0 in sponsor mode. */
  fee: bigint;
}

/** The config type and the params type of each kind. */
interface KindTypes {
  'agglayer-deposit': { config: AgglayerDepositConfig; params: AgglayerDepositRequest };
}

type ConfigOf<K extends RelayKind> = KindTypes[K]['config'];
type ParamsOf<K extends RelayKind> = KindTypes[K]['params'];

/** The config of each kind that a chain supports. A chain without a kind has no entry. */
export type KindConfigs = { readonly [K in RelayKind]?: ConfigOf<K> };

/** The fee call of the batch: none for a zero fee. */
function feeOf(fee: bigint, feeRecipient: Hex | null): RelayFee | null {
  if (fee === 0n) return null;
  if (feeRecipient === null) throw new Error('A fee needs a fee recipient.');
  return { recipient: feeRecipient, amount: fee };
}

const agglayerDeposit: KindHandler<AgglayerDepositConfig, AgglayerDepositRequest> = {
  parseConfig(value, path) {
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
  },
  parseParams(value, path) {
    const fields = shape(value, path, ['token', 'amount', 'midenAccountHex', 'fee']);
    const { midenAccountHex } = fields;
    if (typeof midenAccountHex !== 'string' || !MIDEN_ACCOUNT_HEX_PATTERN.test(midenAccountHex)) {
      fail(`${path}.midenAccountHex`, 'must be 0x and 30 hex characters');
    }
    const bridged = amount(fields.amount, `${path}.amount`);
    if (bridged === 0n) fail(`${path}.amount`, 'must be above 0');
    return {
      token: address(fields.token, `${path}.token`, true),
      amount: bridged,
      midenAccountHex: midenAccountHex.toLowerCase(),
      fee: amount(fields.fee, `${path}.fee`)
    };
  },
  tokenOf: params => params.token,
  feeOf: params => params.fee,
  depositOf: params => params.amount + params.fee,
  buildCalls: (config, params, feeRecipient) =>
    buildAgglayerDepositCalls(config, {
      token: params.token,
      amount: params.amount,
      midenAccountHex: params.midenAccountHex,
      fee: feeOf(params.fee, feeRecipient)
    })
};

/** One handler per relay kind. The type requires an entry for each kind of the batch module. */
export const RELAY_KINDS: { readonly [K in RelayKind]: KindHandler<ConfigOf<K>, ParamsOf<K>> } = {
  'agglayer-deposit': agglayerDeposit
};

export function isRelayKind(value: string): value is RelayKind {
  return Object.hasOwn(RELAY_KINDS, value);
}

/** Every relay kind, in registry order. */
const ALL_KINDS: readonly RelayKind[] = Object.keys(RELAY_KINDS).filter(isRelayKind);

/** The kinds that a chain supports, in registry order. */
export function kindsOf(configs: KindConfigs): RelayKind[] {
  return ALL_KINDS.filter(kind => configs[kind] !== undefined);
}

function parseKind<K extends RelayKind>(
  configs: { [P in RelayKind]?: ConfigOf<P> },
  kind: K,
  value: unknown,
  path: string
): void {
  configs[kind] = RELAY_KINDS[kind].parseConfig(value, path);
}

/** Parse the `kinds` object of a chain. Refuse a kind that the registry does not know. Throws ParseError. */
export function parseKinds(value: unknown, path: string): KindConfigs {
  if (!isRecord(value)) fail(path, 'must be an object');
  const configs: { [K in RelayKind]?: ConfigOf<K> } = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!isRelayKind(name)) fail(`${path}.${name}`, 'is not a known relay kind');
    parseKind(configs, name, entry, `${path}.${name}`);
  }
  return configs;
}

/** The parsed `params` of a request, bound to the chain's config of the kind. The route uses it for any kind. */
export interface BoundRelay {
  token: Hex;
  fee: bigint;
  /** The full deposit: the bridged amount and the fee. */
  deposit: bigint;
  /** The calls of the batch. `feeRecipient` is null in sponsor mode. Throws when a value is not valid. */
  buildCalls(feeRecipient: Hex | null): BatchCall[];
}

/**
 * Parse the `params` of a request of the kind and bind them to the chain's config of the kind. Return null when the
 * chain does not support the kind. Throws ParseError when the params do not parse.
 */
export function bindRelay<K extends RelayKind>(kind: K, configs: KindConfigs, params: unknown): BoundRelay | null {
  const config = configs[kind];
  if (config === undefined) return null;
  const handler = RELAY_KINDS[kind];
  const parsed = handler.parseParams(params, 'params');
  return {
    token: handler.tokenOf(parsed),
    fee: handler.feeOf(parsed),
    deposit: handler.depositOf(parsed),
    buildCalls: feeRecipient => handler.buildCalls(config, parsed, feeRecipient)
  };
}
