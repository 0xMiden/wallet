/**
 * The relay EIP-1193 provider: a thin adapter over the relay submitter (`submit.ts`). A bridge flow that sends its own
 * transactions (the Epoch SDK, the Agglayer helpers) gets this provider in the place of the WalletConnect provider.
 * `eth_sendTransaction` becomes a batch of one call that the submitter relays; the read methods go to the chain RPC.
 * The provider knows no bridge, and it adds no rule of its own to a relay: the submitter applies every rule.
 */
import { createWalletClient, custom, type Address, type Chain, type Hash, type Hex, type WalletClient } from 'viem';

import { isRecord } from 'lib/update/guards';

import type { BatchCall } from './batch';
import {
  RELAY_PROVIDER_INVALID_PARAMS,
  RELAY_PROVIDER_UNAUTHORIZED,
  RELAY_PROVIDER_UNSUPPORTED_METHOD,
  RelayProviderRpcError
} from './errors';
import type { RelayReviewedFee } from './guards';
import { RELAY_READ_METHODS, relayRpcRead } from './rpc';
import {
  createRelaySubmitter,
  type RelaySubmitOptions,
  type RelaySubmitter,
  type RelaySubmitterOptions
} from './submit';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EVEN_HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const QUANTITY = /^0x[0-9a-fA-F]+$/;
const UINT256_LIMIT = 1n << 256n;
/** Transaction fields that a batch call cannot carry. */
const UNRELAYABLE_FIELDS = ['authorizationList', 'blobs', 'blobVersionedHashes', 'maxFeePerBlobGas'];

/** The arguments of an EIP-1193 request. */
export interface RelayRequestArguments {
  method: string;
  params?: unknown;
}

/**
 * The EIP-1193 `request` function. The result type is the caller's: viem types the result of each method from its
 * own RPC schema, and an EIP-1193 provider cannot prove it at run time.
 */
export type RelayRequestFn = <T = unknown>(args: RelayRequestArguments) => Promise<T>;

/**
 * Gives the reviewed fee of ONE send (`deduct` mode): it is given the calls of that send, without the fee call. The
 * caller implements it with a quote (`quoteRelayFee`) and its own review limit, and throws to stop the send; nothing
 * is signed then. A flow that sends several transactions for one user action (`approve`, then `deposit`) makes one
 * relay for each, and each relay pays its own quoted fee.
 */
export type RelaySendFee = (calls: BatchCall[]) => Promise<RelayReviewedFee>;

/** The options that go to each send of the provider. */
export interface RelaySendHooks extends RelaySubmitOptions {
  /**
   * `deduct` mode only: the reviewed fee of each send, in the place of one `fee` for every send. Do not give both.
   * Without it, each send uses `fee`.
   */
  feeFor?: RelaySendFee;
}

export interface RelayProviderOptions extends RelaySubmitterOptions, RelaySendHooks {
  /** The chain's RPC endpoint. The read methods go there. */
  rpcUrl: string;
  /** Tests replace the RPC read. */
  readRpc?: (method: string, params: unknown) => Promise<unknown>;
}

export interface RelayProvider {
  readonly chainId: number;
  readonly address: Address;
  /** EIP-1193: accounts, chain id, `eth_sendTransaction` (one call per batch) and the read methods. */
  request: RelayRequestFn;
  /**
   * Relays the calls as one batch and gives the final transaction hash. A flow can put `approve` and the bridge call
   * in one batch, which pays one fee in `deduct` mode.
   */
  sendCalls(calls: BatchCall[]): Promise<Hash>;
  /** The submitter under the provider. Use its `resume` to follow a job that `onJob` recorded. */
  submitter: RelaySubmitter;
}

function invalidParams(message: string): RelayProviderRpcError {
  return new RelayProviderRpcError(RELAY_PROVIDER_INVALID_PARAMS, `relay provider: ${message}`);
}

function unsupported(method: string): RelayProviderRpcError {
  return new RelayProviderRpcError(RELAY_PROVIDER_UNSUPPORTED_METHOD, `relay provider: ${method} is not supported`);
}

function sameHex(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function quantity(value: unknown, what: string): bigint {
  if (typeof value !== 'string' || !QUANTITY.test(value)) throw invalidParams(`${what} is not a hex quantity`);
  const parsed = BigInt(value);
  if (parsed >= UINT256_LIMIT) throw invalidParams(`${what} is too large`);
  return parsed;
}

/** A chain id as a hex quantity or a safe integer. */
function chainIdOf(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  return Number(quantity(value, 'the chain id'));
}

function calldata(value: unknown): Hex {
  if (typeof value !== 'string' || !EVEN_HEX.test(value)) throw invalidParams('the data is not hex bytes');
  return `0x${value.slice(2).toLowerCase()}`;
}

/**
 * A relay EIP-1193 provider for one relay address on one chain. The optional `beforeSign`, `onJob` and `fee` go to
 * each `submit`, so a flow that uses the provider also gets the review check and the durable job reference. With
 * `feeFor`, each send asks it for its own reviewed fee first. Throws a `TypeError` when both `fee` and `feeFor` are
 * given. See the module comment.
 */
export function createRelayProvider(options: RelayProviderOptions): RelayProvider {
  const { rpcUrl, feeFor } = options;
  if (feeFor !== undefined && options.fee !== undefined) {
    throw new TypeError('relay provider: give a fee or a fee function, not both');
  }
  const submitter = createRelaySubmitter(options);
  const { chainId, address } = submitter;
  const submitOptions: RelaySubmitOptions = {
    beforeSign: options.beforeSign,
    onJob: options.onJob,
    fee: options.fee
  };
  const readRpc = options.readRpc ?? ((method, params) => relayRpcRead(rpcUrl, method, params));

  /** The call of an `eth_sendTransaction`. Gas fields are ignored: the relayer sets the gas. */
  function transactionCall(params: unknown): BatchCall {
    const tx = Array.isArray(params) ? params[0] : undefined;
    if (!isRecord(tx)) throw invalidParams('eth_sendTransaction takes one transaction object');
    const from = tx.from;
    if (typeof from !== 'string' || !sameHex(from, address)) {
      throw new RelayProviderRpcError(
        RELAY_PROVIDER_UNAUTHORIZED,
        'relay provider: the sender is not the relay address'
      );
    }
    if (tx.chainId !== undefined && chainIdOf(tx.chainId) !== chainId) throw invalidParams('the chain id is not ours');
    if (UNRELAYABLE_FIELDS.some(field => tx[field] !== undefined)) {
      throw invalidParams('the transaction carries fields that a batch call cannot carry');
    }
    if (typeof tx.to !== 'string' || !ADDRESS.test(tx.to)) throw invalidParams('the transaction needs a target');
    const data = tx.data ?? tx.input ?? '0x';
    if (tx.data !== undefined && tx.input !== undefined && !sameHex(String(tx.data), String(tx.input))) {
      throw invalidParams('data and input differ');
    }
    return {
      to: `0x${tx.to.slice(2)}`,
      value: tx.value === undefined ? 0n : quantity(tx.value, 'the value'),
      data: calldata(data)
    };
  }

  /** The submit options of one send: with `feeFor`, the reviewed fee of these calls. */
  async function sendOptions(calls: BatchCall[]): Promise<RelaySubmitOptions> {
    if (feeFor === undefined) return submitOptions;
    return { ...submitOptions, fee: await feeFor([...calls]) };
  }

  /**
   * Relays the calls through the submitter and gives the final hash. The submitter (and the quote client of a
   * `feeFor`) throws a `TypeError` only for a call that it cannot take, before any signature: that is an EIP-1193
   * parameter error. Every relay error goes to the caller as it is (viem keeps it as the `cause` of its own error).
   */
  async function sendCalls(calls: BatchCall[]): Promise<Hash> {
    try {
      return (await submitter.submit(calls, await sendOptions(calls))).hash;
    } catch (error) {
      if (error instanceof TypeError) throw invalidParams(error.message);
      throw error;
    }
  }

  function switchChain(params: unknown): null {
    const target = Array.isArray(params) ? params[0] : undefined;
    if (!isRecord(target)) throw invalidParams('wallet_switchEthereumChain takes a chain');
    if (chainIdOf(target.chainId) !== chainId) throw unsupported('wallet_switchEthereumChain to another chain');
    return null;
  }

  async function handle({ method, params }: RelayRequestArguments): Promise<unknown> {
    switch (method) {
      case 'eth_accounts':
      case 'eth_requestAccounts':
        return [address];
      case 'eth_chainId':
        return `0x${chainId.toString(16)}`;
      case 'wallet_switchEthereumChain':
        return switchChain(params);
      case 'eth_sendTransaction':
        return sendCalls([transactionCall(params)]);
      default:
        if (RELAY_READ_METHODS.has(method)) return readRpc(method, params ?? []);
        throw unsupported(method);
    }
  }

  // The overload gives the EIP-1193 result type of the caller; the implementation returns the JSON-RPC result.
  function request<T = unknown>(args: RelayRequestArguments): Promise<T>;
  function request(args: RelayRequestArguments): Promise<unknown> {
    return handle(args);
  }

  return { chainId, address, request, sendCalls, submitter };
}

/**
 * A viem `WalletClient` over the relay provider, for a flow that takes a wallet client (the Epoch SDK). Its account is
 * the relay address, a JSON-RPC account, so `sendTransaction` and `writeContract` reach `eth_sendTransaction`.
 */
export function createRelayWalletClient(provider: RelayProvider, chain: Chain): WalletClient {
  if (chain.id !== provider.chainId) throw new TypeError('relay provider: the chain is not the chain of the provider');
  return createWalletClient({ account: provider.address, chain, transport: custom(provider) });
}
