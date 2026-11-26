import { zeroAddress, type Address, type Hex } from 'viem';
import { hashAuthorization } from 'viem/utils';

import { batchDigest, isRelayNonce, type BatchCall } from 'lib/evm-relay/batch';
import type { RelayChainConfig } from 'lib/remote-config/schema';

/**
 * The rules of the relay key. The relay key signs only two things, and this module builds the digest of each from
 * the backend's own config and the account:
 * - an EIP-7702 authorization that delegates the relay address to the pinned Calibur contract of the chain;
 * - a Calibur batch of 1 to 8 calls, with the configured executor, the relay nonce key and a near deadline. No call
 *   goes to the relay address itself.
 * The request comes from a less trusted realm, so each field is read as untrusted JSON. The request never gives a
 * digest, a delegate or an executor. This module has no I/O.
 */

/** The stable reason of a refused request. */
export type RelaySignRefusal =
  | 'request'
  | 'op'
  | 'chain-id'
  | 'nonce'
  | 'calls'
  | 'call'
  | 'call-to'
  | 'call-value'
  | 'call-data'
  | 'batch-nonce'
  | 'batch-nonce-key'
  | 'salt'
  | 'deadline'
  | 'relay-address';

export class RelaySignRuleError extends Error {
  constructor(readonly reason: RelaySignRefusal) {
    super(`Relay signature refused: ${reason}`);
    this.name = 'RelaySignRuleError';
  }
}

/** What the backend knows. No field comes from the request. */
export interface RelaySignContext {
  /** The account's relay address. It is the verifying contract of a batch. */
  relayAddress: string;
  chain: RelayChainConfig;
  /** Unix time in seconds. */
  nowSeconds: number;
}

/** The digest to sign. For an authorization, also the unsigned authorization. */
export type RelaySignPlan =
  | { op: 'authorization'; digest: Hex; authorization: { address: Address; chainId: number; nonce: number } }
  | { op: 'batch'; digest: Hex };

/** The longest time from now to a batch deadline. */
export const MAX_RELAY_DEADLINE_SECONDS = 24 * 60 * 60;
/** The most calls in one batch. The relay contract has the same limit. */
export const MAX_RELAY_CALLS = 8;
/** The longest calldata of one call. It bounds the work of a request; a bridge call is far shorter. */
export const MAX_RELAY_CALL_DATA_BYTES = 32 * 1024;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const EVEN_HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
// A decimal with no sign and no leading zero. 2^256 has 78 digits.
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
const UINT256_LIMIT = 1n << 256n;

const AUTHORIZATION_KEYS = ['op', 'chainId', 'nonce'];
const BATCH_KEYS = ['op', 'chainId', 'calls', 'batchNonce', 'salt', 'deadline'];
const CALL_KEYS = ['to', 'value', 'data'];

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

/**
 * One call: a uint256 value, calldata of whole bytes, and a target that is not the zero address and not the relay
 * address itself. A call to itself could change the Calibur state of the address (for example register a new key),
 * and that change would also control every later deposit.
 */
function batchCall(value: unknown, relayAddress: Address): BatchCall {
  const call = exactRecord(value, CALL_KEYS, 'call');
  const to = address(call.to, 'call-to');
  if (to === zeroAddress || to === relayAddress) throw new RelaySignRuleError('call-to');
  const data = call.data;
  if (typeof data !== 'string' || !EVEN_HEX.test(data) || (data.length - 2) / 2 > MAX_RELAY_CALL_DATA_BYTES) {
    throw new RelaySignRuleError('call-data');
  }
  return { to, value: uint256(call.value, 'call-value'), data: `0x${data.slice(2).toLowerCase()}` };
}

function batchCalls(value: unknown, relayAddress: Address): BatchCall[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RELAY_CALLS) {
    throw new RelaySignRuleError('calls');
  }
  return value.map(call => batchCall(call, relayAddress));
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

function batchPlanDigest(request: Record<string, unknown>, chainId: number, context: RelaySignContext): Hex {
  const { chain } = context;
  const relayAddress = address(context.relayAddress, 'relay-address');
  const calls = batchCalls(request.calls, relayAddress);
  const batchNonce = uint256(request.batchNonce, 'batch-nonce');
  if (!isRelayNonce(batchNonce)) throw new RelaySignRuleError('batch-nonce-key');
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
 * The delegate, the executor and the Calibur domain come from `context` only.
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
      return { op: 'batch', digest: batchPlanDigest(fields, chainId, context) };
    }
    default:
      throw new RelaySignRuleError('op');
  }
}
