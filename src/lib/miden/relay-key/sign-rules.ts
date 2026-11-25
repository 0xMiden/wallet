import { zeroAddress, type Address, type Hex } from 'viem';
import { hashAuthorization } from 'viem/utils';

import {
  batchDigest,
  buildRelayCalls,
  isMidenAccountHex,
  nonceKeyOf,
  type AgglayerDepositConfig,
  type RelayFee
} from 'lib/evm-relay/batch';
import type { RelayChainConfig } from 'lib/remote-config/schema';

/**
 * The rules of the relay key. The relay key signs only two things, and this module builds the digest of each from
 * the backend's own config and the account:
 * - an EIP-7702 authorization that delegates the relay address to the pinned Calibur contract of the chain;
 * - a Calibur batch of a known kind, whose calls bridge to the account's own Miden account.
 * The request comes from a less trusted realm, so each field is read as untrusted JSON. This module has no I/O.
 */

/** The stable reason of a refused request. */
export type RelaySignRefusal =
  | 'request'
  | 'op'
  | 'chain-id'
  | 'nonce'
  | 'kind'
  | 'params'
  | 'token'
  | 'amount'
  | 'fee'
  | 'fee-token'
  | 'fee-amount'
  | 'fee-recipient'
  | 'batch-nonce'
  | 'batch-nonce-key'
  | 'salt'
  | 'deadline'
  | 'account'
  | 'relay-address'
  | 'agglayer';

export class RelaySignRuleError extends Error {
  constructor(readonly reason: RelaySignRefusal) {
    super(`Relay signature refused: ${reason}`);
    this.name = 'RelaySignRuleError';
  }
}

/** What the backend knows. No field comes from the request. */
export interface RelaySignContext {
  /** The account's own Miden account ID: `0x` and 30 hex characters. */
  midenAccountHex: string;
  /** The account's relay address. It is the verifying contract of a batch. */
  relayAddress: string;
  chain: RelayChainConfig;
  /** The Agglayer deposit values of the chain. Null when the chain takes no Agglayer deposit. */
  agglayer: AgglayerDepositConfig | null;
  /** Unix time in seconds. */
  nowSeconds: number;
}

/** The digest to sign. For an authorization, also the unsigned authorization. */
export type RelaySignPlan =
  | { op: 'authorization'; digest: Hex; authorization: { address: Address; chainId: number; nonce: number } }
  | { op: 'batch'; digest: Hex };

/** The longest time from now to a batch deadline. */
export const MAX_RELAY_DEADLINE_SECONDS = 24 * 60 * 60;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
// A decimal with no sign and no leading zero. 2^256 has 78 digits.
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
const UINT256_LIMIT = 1n << 256n;

const AUTHORIZATION_KEYS = ['op', 'chainId', 'nonce'];
const BATCH_KEYS = ['op', 'chainId', 'kind', 'params', 'batchNonce', 'salt', 'deadline'];
const AGGLAYER_DEPOSIT_PARAMS_KEYS = ['token', 'amount', 'fee'];
const FEE_KEYS = ['recipient', 'amount'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value as an object with exactly these keys. A missing or an extra key is refused. */
function exactRecord(value: unknown, keys: string[], reason: RelaySignRefusal): Record<string, unknown> {
  if (!isRecord(value)) throw new RelaySignRuleError(reason);
  const own = Object.keys(value);
  if (own.length !== keys.length || !keys.every(key => own.includes(key))) throw new RelaySignRuleError(reason);
  return value;
}

function address(value: unknown, reason: RelaySignRefusal): Address {
  if (typeof value !== 'string' || !ADDRESS.test(value)) throw new RelaySignRuleError(reason);
  return `0x${value.slice(2).toLowerCase()}`;
}

function uint256(value: unknown, reason: RelaySignRefusal): bigint {
  if (typeof value !== 'string' || !DECIMAL.test(value)) throw new RelaySignRuleError(reason);
  const parsed = BigInt(value);
  if (parsed >= UINT256_LIMIT) throw new RelaySignRuleError(reason);
  return parsed;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * The chain ID of a request, read before the caller looks up the chain's config. It is a positive safe integer;
 * `planRelaySignature` checks again that it is the chain of the config.
 */
export function relaySignChainId(request: unknown): number {
  const chainId = isRecord(request) ? request.chainId : undefined;
  if (!positiveSafeInteger(chainId)) throw new RelaySignRuleError('chain-id');
  return chainId;
}

function checkedChainId(value: unknown, chain: RelayChainConfig): number {
  if (!positiveSafeInteger(value) || value !== chain.chainId) throw new RelaySignRuleError('chain-id');
  return value;
}

/** The fee of a batch: only in a token with a cap, at most the cap, to a non-zero recipient. */
function relayFee(value: unknown, token: Address, chain: RelayChainConfig): RelayFee | null {
  if (value === null) return null;
  const fee = exactRecord(value, FEE_KEYS, 'fee');
  const cap = Object.prototype.hasOwnProperty.call(chain.maxFee, token) ? chain.maxFee[token] : undefined;
  if (cap === undefined) throw new RelaySignRuleError('fee-token');
  const amount = uint256(fee.amount, 'fee-amount');
  if (amount === 0n || amount > BigInt(cap)) throw new RelaySignRuleError('fee-amount');
  const recipient = address(fee.recipient, 'fee-recipient');
  if (recipient === zeroAddress) throw new RelaySignRuleError('fee-recipient');
  return { recipient, amount };
}

/** The salt of the relay address's Calibur domain: 32 bytes that end with the Calibur address. */
function caliburSalt(value: unknown, chain: RelayChainConfig): Hex {
  if (typeof value !== 'string' || !BYTES32.test(value)) throw new RelaySignRuleError('salt');
  const salt: Hex = `0x${value.slice(2).toLowerCase()}`;
  if (salt.slice(-40) !== chain.calibur.address.slice(2).toLowerCase()) throw new RelaySignRuleError('salt');
  return salt;
}

/** A deadline after now and at most `MAX_RELAY_DEADLINE_SECONDS` after now. */
function deadline(value: unknown, nowSeconds: number): bigint {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= nowSeconds ||
    value > nowSeconds + MAX_RELAY_DEADLINE_SECONDS
  ) {
    throw new RelaySignRuleError('deadline');
  }
  return BigInt(value);
}

function agglayerDepositDigest(request: Record<string, unknown>, chainId: number, context: RelaySignContext): Hex {
  const { chain } = context;
  if (context.agglayer === null) throw new RelaySignRuleError('agglayer');
  if (!isMidenAccountHex(context.midenAccountHex)) throw new RelaySignRuleError('account');
  const relayAddress = address(context.relayAddress, 'relay-address');

  const params = exactRecord(request.params, AGGLAYER_DEPOSIT_PARAMS_KEYS, 'params');
  const token = address(params.token, 'token');
  const amount = uint256(params.amount, 'amount');
  if (amount === 0n) throw new RelaySignRuleError('amount');
  const fee = relayFee(params.fee, token, chain);

  const batchNonce = uint256(request.batchNonce, 'batch-nonce');
  // The nonce is under 2^256 and its top 192 bits are the key, so its sequence (the low 64 bits) fits a uint64.
  if (batchNonce >> 64n !== nonceKeyOf('agglayer-deposit')) throw new RelaySignRuleError('batch-nonce-key');

  const calls = buildRelayCalls('agglayer-deposit', context.agglayer, {
    token,
    amount,
    midenAccountHex: context.midenAccountHex,
    fee
  });
  const envelope = {
    chainId,
    evmAddress: relayAddress,
    executor: chain.executor,
    batchNonce,
    salt: caliburSalt(request.salt, chain),
    deadline: deadline(request.deadline, context.nowSeconds)
  };
  return batchDigest(chain.calibur, envelope, calls);
}

/**
 * The digest that the relay key signs for `request`. Throws `RelaySignRuleError` when a rule refuses the request.
 * The delegate, the executor, the Calibur domain, the bridge and the Miden destination come from `context` only.
 */
export function planRelaySignature(request: unknown, context: RelaySignContext): RelaySignPlan {
  if (!isRecord(request)) throw new RelaySignRuleError('request');
  switch (request.op) {
    case 'authorization': {
      const fields = exactRecord(request, AUTHORIZATION_KEYS, 'request');
      const chainId = checkedChainId(fields.chainId, context.chain);
      const nonce = fields.nonce;
      if (typeof nonce !== 'number' || !Number.isSafeInteger(nonce) || nonce < 0) {
        throw new RelaySignRuleError('nonce');
      }
      const authorization = { address: context.chain.calibur.address, chainId, nonce };
      return { op: 'authorization', digest: hashAuthorization(authorization), authorization };
    }
    case 'batch': {
      const fields = exactRecord(request, BATCH_KEYS, 'request');
      const chainId = checkedChainId(fields.chainId, context.chain);
      switch (fields.kind) {
        case 'agglayer-deposit':
          return { op: 'batch', digest: agglayerDepositDigest(fields, chainId, context) };
        default:
          throw new RelaySignRuleError('kind');
      }
    }
    default:
      throw new RelaySignRuleError('op');
  }
}
