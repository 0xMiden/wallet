// Read the state of a deposit address from the chain RPC. The reader sends only the reads below, in at most two
// JSON-RPC batches (two HTTP requests). It is not a general RPC proxy.
import { decodeFunctionResult, encodeFunctionData, hexToBigInt, isHex, keccak256 } from 'viem';

import type { ChainConfig, Hex } from './config';
import { notConfigured } from './errors';
import { isRecord } from './http';
import { rpcUrlOf } from './secrets';
import type { Env } from './types';
import {
  CALIBUR_ABI,
  ERC20_ABI,
  isCaliburDelegation,
  isNativeToken,
  nonceKeyOf,
  type RelayKind
} from '../../../src/lib/evm-relay/batch';

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
  /** One balance per token of the chain, in config order. */
  balances: bigint[];
  /** The Calibur sequence of each requested kind. */
  sequences: ReadonlyMap<RelayKind, bigint>;
}

/** The chain access of the account route. The tests give a fake. */
export interface ChainReader {
  readAccount(chain: ChainConfig, address: Hex, kinds: readonly RelayKind[]): Promise<AccountState>;
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
  params: (string | Record<string, unknown>)[];
}

const IMPLEMENTATION_CACHE = new Map<string, CachedCode>();

function unavailable(): RpcUnavailableError {
  return new RpcUnavailableError('The chain RPC does not answer.');
}

/** Send the calls as one JSON-RPC batch. Return one hex result per call, in call order. */
async function rpcBatch(fetcher: Fetcher, url: string, calls: RpcCall[], signal: AbortSignal): Promise<Hex[]> {
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
  const results = new Map<number, Hex>();
  for (const item of payload) {
    if (!isRecord(item) || typeof item.id !== 'number' || !isHex(item.result)) throw unavailable();
    results.set(item.id, item.result);
  }
  return calls.map((_call, id) => {
    const result = results.get(id);
    if (result === undefined) throw unavailable();
    return result;
  });
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
  return ethCall(token, encodeFunctionData({ abi: ERC20_ABI, functionName: 'balanceOf', args: [address] }), null);
}

function decodeBalance(token: Hex, result: Hex): bigint {
  if (isNativeToken(token)) return decoded(() => hexToBigInt(result));
  return decoded(() => decodeFunctionResult({ abi: ERC20_ABI, functionName: 'balanceOf', data: result }));
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
  const fetcher: Fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const cache = options.cache ?? IMPLEMENTATION_CACHE;

  async function readAccount(chain: ChainConfig, address: Hex, kinds: readonly RelayKind[]): Promise<AccountState> {
    const url = rpcUrlOf(env, chain.chainId);
    if (url === null) throw notConfigured();
    const signal = AbortSignal.timeout(RPC_TIMEOUT_MS);
    const pin = chain.calibur;
    const cacheKey = `${chain.chainId}:${pin.address}:${pin.runtimeHash}`;
    const cached = cache.get(cacheKey);
    const known = cached !== undefined && cached.expiresAt > now() ? cached.code : null;
    const tokens = [...chain.tokens.keys()];

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

    // Batch 2: the sequences and the domain. Storage of an earlier delegation stays on the address, so an address
    // that does not delegate now reads them with the Calibur code put on it by a state override.
    const override = delegated ? null : { [address]: { code: implementation } };
    const second = await rpcBatch(
      fetcher,
      url,
      [
        ...kinds.map(kind =>
          ethCall(
            address,
            encodeFunctionData({ abi: CALIBUR_ABI, functionName: 'getSeq', args: [nonceKeyOf(kind)] }),
            override
          )
        ),
        ethCall(address, encodeFunctionData({ abi: CALIBUR_ABI, functionName: 'eip712Domain' }), override)
      ],
      signal
    );
    const sequences = new Map<RelayKind, bigint>();
    kinds.forEach((kind, index) => {
      const data = resultAt(second, index);
      sequences.set(
        kind,
        decoded(() => decodeFunctionResult({ abi: CALIBUR_ABI, functionName: 'getSeq', data }))
      );
    });
    return {
      delegated,
      authorizationNonce: decodeNonce(resultAt(first, 1)),
      salt: verifiedSalt(resultAt(second, kinds.length), chain, address),
      balances: tokens.map((token, index) => decodeBalance(token, resultAt(first, 2 + index))),
      sequences
    };
  }

  return { readAccount };
}
