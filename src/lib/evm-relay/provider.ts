/**
 * The relay EIP-1193 provider: the one place where the relay meets a bridge flow. A bridge flow sends its own
 * transaction through it, as it does through the WalletConnect provider. The provider puts the calls in one Calibur
 * batch, has the backend sign it with the relay key (the `signRelay` action), relays it, and gives the mined hash.
 * It knows no bridge.
 */
import {
  createWalletClient,
  custom,
  zeroAddress,
  zeroHash,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type WalletClient
} from 'viem';

import type { RelayChainConfig } from 'lib/remote-config/schema';
import type { RelaySignedAuthorization, RelaySignRequest, RelaySignResult } from 'lib/shared/types';
import { isRecord } from 'lib/update/guards';

import { batchDigest, batchNonceOf, buildFeeCall, type BatchCall, type BatchEnvelope } from './batch';
import {
  fetchRelayAccount,
  fetchRelayJob,
  relayCallBody,
  submitRelay,
  type RelayAccountQuery,
  type RelayJobQuery
} from './client';
import {
  RELAY_PROVIDER_INVALID_PARAMS,
  RELAY_PROVIDER_UNAUTHORIZED,
  RELAY_PROVIDER_UNSUPPORTED_METHOD,
  RelayApiError,
  RelayMismatchError,
  RelayProviderRpcError,
  RelayRefusedError,
  RelayRevertedError,
  RelayStillPendingError,
  relayErrorAction
} from './errors';
import { acceptedFee, assertRelayAccountMatches, assertRelayJobMatches } from './guards';
import { lowerAddress } from './parse';
import { RELAY_READ_METHODS, relayRpcRead } from './rpc';
import type { RelayAccount, RelayJob, RelaySubmission } from './types';

/** The most calls in one batch, the fee call included. The relay contract has the same limit. */
export const MAX_RELAY_BATCH_CALLS = 8;
/** The time from the signature to the batch deadline. The relay takes 60 seconds to 24 hours. */
export const RELAY_DEADLINE_SECONDS = 30 * 60;
/** The time between two reads of an open job. */
export const RELAY_POLL_MS = 5_000;
/** The longest wait for a job to become final. */
export const RELAY_WAIT_MS = 10 * 60_000;
/** The most times a relay signs again after `stale_request`. */
export const MAX_STALE_RETRIES = 2;

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

export interface RelayProviderOptions {
  /** The relay entry of the chain in the remote config (`getRelayChain`). */
  chain: RelayChainConfig;
  /** The account's `relayEvmAddress`. */
  address: Address;
  /** The chain's RPC endpoint. The read methods go there. */
  rpcUrl: string;
  /** The token that pays the fee in `deduct` mode. The zero address is the native coin. */
  feeToken?: Address;
  /** Signs through the backend: `request => signRelay(accountPublicKey, request)`. */
  sign: (request: RelaySignRequest) => Promise<RelaySignResult>;
  /** Tests replace the service calls, the RPC read, the clock (ms) and the wait. */
  fetchAccount?: (query: RelayAccountQuery) => Promise<RelayAccount>;
  submit?: (submission: RelaySubmission) => Promise<RelayJob>;
  fetchJob?: (query: RelayJobQuery) => Promise<RelayJob>;
  readRpc?: (method: string, params: unknown) => Promise<unknown>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
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

function sleepFor(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

/**
 * The fee token in lower case. viem refuses an address in mixed case that is not a checksum, so every address in a
 * call is in lower case.
 */
function feeTokenOf(token: Address | undefined): Address | undefined {
  if (token === undefined) return undefined;
  const lower = lowerAddress(token);
  if (lower === null) throw new TypeError('relay provider: the fee token is not valid');
  return lower;
}

function retryAfterMs(error: unknown): number {
  return error instanceof RelayApiError && error.retryAfter !== undefined ? error.retryAfter * 1000 : 0;
}

/** A relay EIP-1193 provider for one relay address on one chain. See the module comment. */
export function createRelayProvider(options: RelayProviderOptions): RelayProvider {
  const { chain, rpcUrl, sign } = options;
  const chainId = chain.chainId;
  const relayAddress = lowerAddress(options.address);
  if (relayAddress === null) throw new TypeError('relay provider: the relay address is not valid');
  const address: Address = relayAddress;
  const feeToken = feeTokenOf(options.feeToken);
  const fetchAccount = options.fetchAccount ?? (query => fetchRelayAccount(query));
  const submit = options.submit ?? (submission => submitRelay(submission));
  const fetchJob = options.fetchJob ?? (query => fetchRelayJob(query));
  const readRpc = options.readRpc ?? ((method, params) => relayRpcRead(rpcUrl, method, params));
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? sleepFor;

  /** One call as the vault takes it: a target that is not the zero address and not the relay address itself. */
  function checkedCall(call: BatchCall): BatchCall {
    const to = lowerAddress(call.to);
    if (to === null || to === zeroAddress || to === address) throw invalidParams('the call target is not valid');
    if (call.value < 0n || call.value >= UINT256_LIMIT) throw invalidParams('the call value is not a uint256');
    return { to, value: call.value, data: calldata(call.data) };
  }

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

  /** The calls with the fee call last in `deduct` mode. Throws `RelayRefusedError` for a fee it does not accept. */
  function batchWithFee(calls: BatchCall[], account: RelayAccount): BatchCall[] {
    switch (account.mode) {
      case 'sponsor':
        return calls;
      case 'deduct': {
        if (feeToken === undefined) throw new RelayRefusedError('no-fee-token');
        if (!account.fees.some(entry => sameHex(entry.token, feeToken))) throw new RelayRefusedError('no-fee');
        const fee = acceptedFee(account, chain, feeToken);
        if (fee === null || account.feeRecipient === null) throw new RelayRefusedError('fee-not-accepted');
        return [...calls, buildFeeCall({ token: feeToken, recipient: account.feeRecipient, amount: fee })];
      }
    }
  }

  function assertTargetsAllowed(calls: BatchCall[], allowedTargets: Address[] | null): void {
    if (allowedTargets === null) return;
    if (!calls.every(call => allowedTargets.some(target => sameHex(target, call.to)))) {
      throw new RelayRefusedError('target-not-allowed');
    }
  }

  async function signAuthorization(nonce: number): Promise<RelaySignedAuthorization> {
    const signed = await sign({ op: 'authorization', chainId, nonce });
    if (
      signed.op !== 'authorization' ||
      !sameHex(signed.authorization.address, chain.calibur.address) ||
      signed.authorization.chainId !== chainId ||
      signed.authorization.nonce !== nonce
    ) {
      throw new RelayMismatchError('relay: the backend signed another authorization');
    }
    return signed.authorization;
  }

  /** Reads the job until it is final. Gives the hash of a succeeded job; throws for a reverted or a late one. */
  async function followJob(job: RelayJob): Promise<Hash> {
    const started = now();
    let current = job;
    let delay = RELAY_POLL_MS;
    for (;;) {
      switch (current.state) {
        case 'succeeded':
          return current.txHash;
        case 'reverted':
          throw new RelayRevertedError(current.id, current.txHash);
        case 'pending':
          break;
      }
      if (now() - started >= RELAY_WAIT_MS) throw new RelayStillPendingError(current.id, current.txHash);
      await sleep(delay);
      try {
        const next = await fetchJob({ id: current.id, chainId });
        assertRelayJobMatches(next, current.id);
        current = next;
        delay = RELAY_POLL_MS;
      } catch (error) {
        // The job is submitted: a passing failure of a read does not end the wait.
        if (relayErrorAction(error) !== 'wait') throw error;
        delay = Math.max(RELAY_POLL_MS, retryAfterMs(error));
      }
    }
  }

  /** Waits until the open job of `busy` is final or gone. Then the address takes a new batch. */
  async function waitForOpenJob(id: Hex): Promise<void> {
    try {
      await followJob({ id, state: 'pending', txHash: zeroHash });
    } catch (error) {
      if (error instanceof RelayRevertedError) return;
      if (error instanceof RelayApiError && error.code === 'not_found') return;
      throw error;
    }
  }

  async function relayOnce(calls: BatchCall[]): Promise<Hash> {
    const account = await fetchAccount({ chainId, address });
    assertRelayAccountMatches(account, chain, address);
    const batch = batchWithFee(calls, account);
    if (batch.length > MAX_RELAY_BATCH_CALLS) throw new RelayRefusedError('too-many-calls');
    assertTargetsAllowed(calls, account.allowedTargets);
    const authorization = account.needsAuthorization ? await signAuthorization(account.authorizationNonce) : undefined;
    const envelope: BatchEnvelope = {
      chainId,
      evmAddress: address,
      executor: chain.executor,
      batchNonce: batchNonceOf(account.sequence),
      salt: account.salt,
      deadline: BigInt(Math.floor(now() / 1000) + RELAY_DEADLINE_SECONDS)
    };
    const digest = batchDigest(chain.calibur, envelope, batch);
    const signed = await sign({
      op: 'batch',
      chainId,
      calls: batch.map(relayCallBody),
      batchNonce: envelope.batchNonce.toString(),
      salt: envelope.salt,
      deadline: Number(envelope.deadline)
    });
    if (signed.op !== 'batch' || !sameHex(signed.digest, digest)) {
      throw new RelayMismatchError('relay: the backend signed another batch');
    }
    const submission: RelaySubmission = {
      chainId,
      evmAddress: address,
      calls: batch,
      batchNonce: envelope.batchNonce,
      salt: envelope.salt,
      deadline: envelope.deadline,
      signature: signed.signature
    };
    if (authorization !== undefined) submission.authorization = authorization;
    const job = await submit(submission);
    assertRelayJobMatches(job, digest);
    return followJob(job);
  }

  /** One relay with its bounded retries: sign again after `stale_request`, wait once for the open job of `busy`. */
  async function relay(calls: BatchCall[]): Promise<Hash> {
    let staleRetries = 0;
    let busyWaited = false;
    for (;;) {
      try {
        return await relayOnce(calls);
      } catch (error) {
        if (!(error instanceof RelayApiError)) throw error;
        switch (error.code) {
          case 'stale_request':
            if (staleRetries >= MAX_STALE_RETRIES) throw error;
            staleRetries += 1;
            break;
          case 'busy':
            if (busyWaited || error.id === undefined) throw error;
            busyWaited = true;
            await waitForOpenJob(error.id);
            break;
          default:
            throw error;
        }
      }
    }
  }

  // One relay at a time per provider: two batches of one address would read the same sequence.
  let queue: Promise<unknown> = Promise.resolve();
  function sendCalls(calls: BatchCall[]): Promise<Hash> {
    const run = async (): Promise<Hash> => {
      if (calls.length === 0) throw invalidParams('a batch needs a call');
      return relay(calls.map(checkedCall));
    };
    const result = queue.then(run, run);
    queue = result.catch(() => undefined);
    return result;
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

  return { chainId, address, request, sendCalls };
}

/**
 * A viem `WalletClient` over the relay provider, for a flow that takes a wallet client (the Epoch SDK). Its account is
 * the relay address, a JSON-RPC account, so `sendTransaction` and `writeContract` reach `eth_sendTransaction`.
 */
export function createRelayWalletClient(provider: RelayProvider, chain: Chain): WalletClient {
  if (chain.id !== provider.chainId) throw new TypeError('relay provider: the chain is not the chain of the provider');
  return createWalletClient({ account: provider.address, chain, transport: custom(provider) });
}
