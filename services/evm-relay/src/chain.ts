// Read the chain RPC for the routes and the Sender, and send signed relay transactions. The account read sends at most
// two JSON-RPC batches; the relay read, the receipt read and the fee read one batch each; the broadcast one call. It is
// not a general RPC proxy.
import { decodeFunctionResult, encodeFunctionData, erc20Abi, hexToBigInt, isHex, keccak256, numberToHex } from 'viem';

import type { ChainConfig, Hex } from './config';
import { notConfigured } from './errors';
import { isRecord } from './http';
import { rpcUrlOf } from './secrets';
import type { Env } from './types';
import { CALIBUR_ABI, RELAY_NONCE_KEY, isCaliburDelegation, isNativeToken } from '../../../src/lib/evm-relay/batch';

/** The time budget of one account read, for both batches together. */
export const RPC_TIMEOUT_MS = 8_000;
/** How long a verified Calibur implementation code stays in memory. */
export const IMPLEMENTATION_TTL_MS = 5 * 60_000;

export interface AccountState {
  /** True when the account code is the EIP-7702 delegation to the pinned Calibur. */
  delegated: boolean;
  /** The pending transaction count of the address. */
  authorizationNonce: number;
  /** The salt of the Calibur EIP-712 domain of the address. */
  salt: Hex;
  /** One balance per requested token, in request order. */
  balances: bigint[];
  /** `getSeq(RELAY_NONCE_KEY)` of the address. */
  sequence: bigint;
}

/** An EIP-7702 authorization of the address, as the Sender signs it into a type 4 transaction. */
export interface RelayAuthorization {
  address: Hex;
  chainId: number;
  nonce: number;
  r: Hex;
  s: Hex;
  yParity: number;
}

/** The transaction that the relay route simulates: `execute` on the address, from the relayer. */
export interface RelayCall {
  evmAddress: Hex;
  relayer: Hex;
  /** The calldata of `execute`. */
  data: Hex;
  /** The simulation includes it when it is not null. */
  authorization: RelayAuthorization | null;
}

/** The chain state that the relay route needs, read in one JSON-RPC batch. */
export interface RelayState {
  /** True when the account code is the EIP-7702 delegation to the pinned Calibur. */
  delegated: boolean;
  /** The pending transaction count of the address. */
  authorizationNonce: number;
  /** The pending transaction count of the relayer. */
  relayerNonce: number;
  relayerBalance: bigint;
  /** The base fee of the next block. */
  baseFee: bigint;
  priorityFee: bigint;
  /** The gas estimate of the call, or null when the call reverts. */
  gasEstimate: bigint | null;
}

/** The fees that the node suggests now. */
export interface FeeQuote {
  /** The base fee of the next block. */
  baseFee: bigint;
  priorityFee: bigint;
}

/** The status of a mined transaction. */
export type ReceiptStatus = 'success' | 'reverted';

/** `nonce_used`: the node refuses the bytes because a mined transaction already holds their nonce. */
export type BroadcastOutcome = 'accepted' | 'nonce_used';

/** The `maxFeePerGas` of a relay transaction: twice the base fee plus the priority fee. */
export function maxFeeOf({ baseFee, priorityFee }: FeeQuote): bigint {
  return 2n * baseFee + priorityFee;
}

/** The chain access of the routes. The tests give a fake. */
export interface ChainReader {
  /** Read the address and the balance of each token. The zero address is the native coin. */
  readAccount(chain: ChainConfig, address: Hex, tokens: readonly Hex[]): Promise<AccountState>;
  readRelay(chain: ChainConfig, call: RelayCall): Promise<RelayState>;
}

/** The RPC failed, timed out or sent an answer that does not decode. */
export class RpcUnavailableError extends Error {}

/** The chain does not hold the pinned Calibur, or the signing domain is not the expected one. */
export class ChainIntegrityError extends Error {}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface ReaderOptions {
  fetcher?: Fetcher;
  now?: () => number;
  /** The implementation code cache. The default is shared by every request of the isolate. */
  cache?: Map<string, CachedCode>;
}

export interface CachedCode {
  code: Hex;
  expiresAt: number;
}

interface RpcCall {
  method: string;
  params: unknown[];
}

/** The answer to one call of a batch: a result or a JSON-RPC error. */
export type RpcOutcome = { result: unknown } | { error: { code: number; message: string } };

const IMPLEMENTATION_CACHE = new Map<string, CachedCode>();
const defaultFetcher: Fetcher = (url, init) => fetch(url, init);
const FEE_HISTORY: RpcCall = { method: 'eth_feeHistory', params: ['0x1', 'latest', []] };
const PRIORITY_FEE: RpcCall = { method: 'eth_maxPriorityFeePerGas', params: [] };

function unavailable(): RpcUnavailableError {
  return new RpcUnavailableError('The chain RPC does not answer.');
}

function outcomeOf(item: Record<string, unknown>): RpcOutcome {
  if (Object.hasOwn(item, 'result')) return { result: item.result };
  const { error } = item;
  if (!isRecord(error) || typeof error.code !== 'number') throw unavailable();
  return { error: { code: error.code, message: typeof error.message === 'string' ? error.message : '' } };
}

/** Send the calls as one JSON-RPC batch. Return the outcome of each call, in call order. */
async function sendBatch(fetcher: Fetcher, url: string, calls: RpcCall[], signal: AbortSignal): Promise<RpcOutcome[]> {
  let payload: unknown;
  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(calls.map((call, id) => ({ jsonrpc: '2.0', id, ...call }))),
      signal
    });
    if (!response.ok) throw unavailable();
    payload = await response.json();
  } catch {
    // The error can hold the URL, which is a secret. Do not pass it on.
    throw unavailable();
  }
  if (!Array.isArray(payload)) throw unavailable();
  const outcomes = new Map<number, RpcOutcome>();
  for (const item of payload) {
    if (!isRecord(item) || typeof item.id !== 'number') throw unavailable();
    outcomes.set(item.id, outcomeOf(item));
  }
  return calls.map((_call, id) => {
    const outcome = outcomes.get(id);
    if (outcome === undefined) throw unavailable();
    return outcome;
  });
}

/** The hex result of an outcome. An error or another value is an RPC failure. */
function hexOf(outcome: RpcOutcome | undefined): Hex {
  if (outcome === undefined || !('result' in outcome) || !isHex(outcome.result)) throw unavailable();
  return outcome.result;
}

/** Send the calls as one JSON-RPC batch. Return one hex result per call, in call order. */
async function rpcBatch(fetcher: Fetcher, url: string, calls: RpcCall[], signal: AbortSignal): Promise<Hex[]> {
  return (await sendBatch(fetcher, url, calls, signal)).map(hexOf);
}

/** Run a decode. A result that does not decode is an RPC failure. */
function decoded<T>(decode: () => T): T {
  try {
    return decode();
  } catch {
    throw unavailable();
  }
}

function resultAt(results: Hex[], index: number): Hex {
  const result = results[index];
  if (result === undefined) throw unavailable();
  return result;
}

const getCode = (address: Hex): RpcCall => ({ method: 'eth_getCode', params: [address, 'latest'] });

function ethCall(to: Hex, data: Hex, override: Record<string, unknown> | null): RpcCall {
  const params: RpcCall['params'] = [{ to, data }, 'latest'];
  if (override !== null) params.push(override);
  return { method: 'eth_call', params };
}

function balanceCall(token: Hex, address: Hex): RpcCall {
  if (isNativeToken(token)) return { method: 'eth_getBalance', params: [address, 'latest'] };
  return ethCall(token, encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [address] }), null);
}

function decodeBalance(token: Hex, result: Hex): bigint {
  if (isNativeToken(token)) return decoded(() => hexToBigInt(result));
  return decoded(() => decodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', data: result }));
}

function decodeNonce(result: Hex): number {
  const nonce = decoded(() => hexToBigInt(result));
  if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) throw unavailable();
  return Number(nonce);
}

/** Return the code when its keccak256 is the pinned runtime hash. */
function verifiedImplementation(code: Hex, chain: ChainConfig): Hex {
  if (keccak256(code) !== chain.calibur.runtimeHash) {
    throw new ChainIntegrityError('The Calibur runtime hash does not match the pin.');
  }
  return code;
}

/** Check the EIP-712 domain of the address and return its salt. */
function verifiedSalt(result: Hex, chain: ChainConfig, address: Hex): Hex {
  const [, name, version, chainId, verifyingContract, salt] = decoded(() =>
    decodeFunctionResult({ abi: CALIBUR_ABI, functionName: 'eip712Domain', data: result })
  );
  const pin = chain.calibur;
  // The last 20 bytes of the salt are the Calibur implementation address.
  const valid =
    name === pin.domainName &&
    version === pin.domainVersion &&
    chainId === BigInt(chain.chainId) &&
    verifyingContract.toLowerCase() === address &&
    salt.slice(-40).toLowerCase() === pin.address.slice(2);
  if (!valid) throw new ChainIntegrityError('The Calibur signing domain is not the expected domain.');
  return `0x${salt.slice(2).toLowerCase()}`;
}

/** The reader over the JSON-RPC URL of each chain. */
export function createRpcReader(env: Env, options: ReaderOptions = {}): ChainReader {
  const fetcher: Fetcher = options.fetcher ?? defaultFetcher;
  const now = options.now ?? Date.now;
  const cache = options.cache ?? IMPLEMENTATION_CACHE;

  async function readAccount(chain: ChainConfig, address: Hex, tokens: readonly Hex[]): Promise<AccountState> {
    const url = rpcUrlOf(env, chain.chainId);
    if (url === null) throw notConfigured();
    const signal = AbortSignal.timeout(RPC_TIMEOUT_MS);
    const pin = chain.calibur;
    const cacheKey = `${chain.chainId}:${pin.address}:${pin.runtimeHash}`;
    const cached = cache.get(cacheKey);
    const known = cached !== undefined && cached.expiresAt > now() ? cached.code : null;

    // Batch 1: the account code, the nonce, the balances and, when the cache has none, the Calibur code.
    const first = await rpcBatch(
      fetcher,
      url,
      [
        getCode(address),
        { method: 'eth_getTransactionCount', params: [address, 'pending'] },
        ...tokens.map(token => balanceCall(token, address)),
        ...(known === null ? [getCode(pin.address)] : [])
      ],
      signal
    );
    let implementation = known;
    if (implementation === null) {
      implementation = verifiedImplementation(resultAt(first, 2 + tokens.length), chain);
      cache.set(cacheKey, { code: implementation, expiresAt: now() + IMPLEMENTATION_TTL_MS });
    }
    const delegated = isCaliburDelegation(resultAt(first, 0), pin);

    // Batch 2: the sequence and the domain. Storage of an earlier delegation stays on the address, so an address
    // that does not delegate now reads them with the Calibur code put on it by a state override.
    const override = delegated ? null : { [address]: { code: implementation } };
    const second = await rpcBatch(
      fetcher,
      url,
      [
        ethCall(
          address,
          encodeFunctionData({ abi: CALIBUR_ABI, functionName: 'getSeq', args: [RELAY_NONCE_KEY] }),
          override
        ),
        ethCall(address, encodeFunctionData({ abi: CALIBUR_ABI, functionName: 'eip712Domain' }), override)
      ],
      signal
    );
    const sequence = resultAt(second, 0);
    return {
      delegated,
      authorizationNonce: decodeNonce(resultAt(first, 1)),
      salt: verifiedSalt(resultAt(second, 1), chain, address),
      balances: tokens.map((token, index) => decodeBalance(token, resultAt(first, 2 + index))),
      sequence: decoded(() => decodeFunctionResult({ abi: CALIBUR_ABI, functionName: 'getSeq', data: sequence }))
    };
  }

  async function readRelay(chain: ChainConfig, call: RelayCall): Promise<RelayState> {
    const url = rpcUrlOf(env, chain.chainId);
    if (url === null) throw notConfigured();
    const { evmAddress, relayer } = call;
    // One batch. The estimate includes the authorization when the request has one: a plain call on an address that
    // does not delegate executes nothing and succeeds, so only a simulation with the authorization checks the batch.
    const outcomes = await sendBatch(
      fetcher,
      url,
      [
        getCode(evmAddress),
        { method: 'eth_getTransactionCount', params: [evmAddress, 'pending'] },
        { method: 'eth_getTransactionCount', params: [relayer, 'pending'] },
        { method: 'eth_getBalance', params: [relayer, 'latest'] },
        FEE_HISTORY,
        PRIORITY_FEE,
        { method: 'eth_estimateGas', params: [estimateOf(call)] }
      ],
      AbortSignal.timeout(RPC_TIMEOUT_MS)
    );
    return {
      delegated: isCaliburDelegation(hexOf(outcomes[0]), chain.calibur),
      authorizationNonce: decodeNonce(hexOf(outcomes[1])),
      relayerNonce: decodeNonce(hexOf(outcomes[2])),
      relayerBalance: decoded(() => hexToBigInt(hexOf(outcomes[3]))),
      baseFee: nextBaseFee(outcomes[4]),
      priorityFee: decoded(() => hexToBigInt(hexOf(outcomes[5]))),
      gasEstimate: gasEstimateOf(outcomes[6])
    };
  }

  return { readAccount, readRelay };
}

/** The `eth_estimateGas` transaction of a relay call. */
function estimateOf({ evmAddress, relayer, data, authorization }: RelayCall): Record<string, unknown> {
  const transaction: Record<string, unknown> = { from: relayer, to: evmAddress, data, value: '0x0' };
  if (authorization !== null) {
    const { address, chainId, nonce, r, s, yParity } = authorization;
    transaction.authorizationList = [
      { address, chainId: numberToHex(chainId), nonce: numberToHex(nonce), r, s, yParity: numberToHex(yParity) }
    ];
  }
  return transaction;
}

/** The base fee of the next block: the last entry of `baseFeePerGas` in `eth_feeHistory`. */
function nextBaseFee(outcome: RpcOutcome | undefined): bigint {
  if (outcome === undefined || !('result' in outcome) || !isRecord(outcome.result)) throw unavailable();
  const fees = outcome.result.baseFeePerGas;
  if (!Array.isArray(fees)) throw unavailable();
  const next: unknown = fees[fees.length - 1];
  if (!isHex(next)) throw unavailable();
  return decoded(() => hexToBigInt(next));
}

/** True when a JSON-RPC error of `eth_estimateGas` says that the call reverts, not that the node failed. */
function isRevert({ code, message }: { code: number; message: string }): boolean {
  switch (code) {
    // 3: a revert with data (Geth, Besu). -32015: a VM execution error (Nethermind).
    case 3:
    case -32015:
      return true;
    default:
      return /revert|gas required exceeds/i.test(message);
  }
}

/** The gas estimate, or null when the call reverts. Any other error is an RPC failure. */
function gasEstimateOf(outcome: RpcOutcome | undefined): bigint | null {
  if (outcome !== undefined && 'error' in outcome && isRevert(outcome.error)) return null;
  return decoded(() => hexToBigInt(hexOf(outcome)));
}

/** Send the calls of the Sender as one JSON-RPC batch to the chain's RPC URL. */
function senderBatch(env: Env, chainId: number, calls: RpcCall[], fetcher: Fetcher): Promise<RpcOutcome[]> {
  const url = rpcUrlOf(env, chainId);
  if (url === null) throw unavailable();
  return sendBatch(fetcher, url, calls, AbortSignal.timeout(RPC_TIMEOUT_MS));
}

/**
 * Send signed transaction bytes to the chain. The node answers "already known" when it has the transaction, which is
 * a success. It answers "nonce too low" when a mined transaction holds the nonce: `nonce_used`. Throws
 * RpcUnavailableError on any other failure. The error never holds the bytes or the URL.
 */
export async function broadcastTransaction(
  env: Env,
  chainId: number,
  raw: Hex,
  fetcher: Fetcher = defaultFetcher
): Promise<BroadcastOutcome> {
  const [outcome] = await senderBatch(env, chainId, [{ method: 'eth_sendRawTransaction', params: [raw] }], fetcher);
  if (outcome === undefined) throw unavailable();
  if ('result' in outcome) return 'accepted';
  const { message } = outcome.error;
  // Geth and Erigon: "already known", "nonce too low". Besu: "Known transaction", "NONCE_TOO_LOW". Nethermind:
  // "AlreadyKnown", "OldNonce".
  if (/already ?known|known transaction/i.test(message)) return 'accepted';
  if (/nonce too low|nonce_too_low|oldnonce/i.test(message)) return 'nonce_used';
  throw unavailable();
}

/** The status of a receipt, or null when the chain has none yet. */
function receiptStatusOf(outcome: RpcOutcome): ReceiptStatus | null {
  if (!('result' in outcome)) throw unavailable();
  const { result } = outcome;
  if (result === null) return null;
  if (!isRecord(result)) throw unavailable();
  switch (result.status) {
    case '0x1':
      return 'success';
    case '0x0':
      return 'reverted';
    default:
      throw unavailable();
  }
}

/** The receipt status of each hash, in hash order, in one JSON-RPC batch. Null while the chain has no receipt. */
export async function readReceipts(
  env: Env,
  chainId: number,
  hashes: readonly Hex[],
  fetcher: Fetcher = defaultFetcher
): Promise<(ReceiptStatus | null)[]> {
  if (hashes.length === 0) return [];
  const calls = hashes.map(hash => ({ method: 'eth_getTransactionReceipt', params: [hash] }));
  return (await senderBatch(env, chainId, calls, fetcher)).map(receiptStatusOf);
}

/** The base fee of the next block and the priority fee, in one JSON-RPC batch. */
export async function readFees(env: Env, chainId: number, fetcher: Fetcher = defaultFetcher): Promise<FeeQuote> {
  const [history, priority] = await senderBatch(env, chainId, [FEE_HISTORY, PRIORITY_FEE], fetcher);
  return { baseFee: nextBaseFee(history), priorityFee: decoded(() => hexToBigInt(hexOf(priority))) };
}
