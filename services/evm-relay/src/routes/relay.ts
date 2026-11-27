// POST /v1/relay: check a signed relay batch, simulate it and hand it to the Sender of its chain. The checks run from
// the cheapest to the most expensive: the body, the chain, the envelope, the call rules, the signatures, the address
// rate limit, the stored relay, the chain read and, in `deduct` mode, the fee amount, which needs the estimate and the
// prices. The route takes the calls as the wallet sends them and never builds a call. It never logs the body, a
// signature or an RPC URL.
import { recoverAuthorizationAddress } from 'viem/utils';

import {
  batchDigest,
  encodeExecution,
  isRelayNonce,
  readFeeCall,
  recoverBatchSigner,
  type BatchCall,
  type BatchEnvelope,
  type RelayFee
} from '../../../../src/lib/evm-relay/batch';
import {
  ChainIntegrityError,
  RpcUnavailableError,
  maxFeeOf,
  type RelayAuthorization,
  type RelayCall,
  type RelayState
} from '../chain';
import { routeConfig, type ChainConfig, type GasMode } from '../config';
import { ApiError, invalidRequest, notConfigured } from '../errors';
import { minimumFee, quotedFee } from '../fee';
import { json, readJson } from '../http';
import { ParseError, address, amount, fail, hexBytes, hexData, safeInteger, shape, type Hex } from '../parse';
import { feeIn, isFeeToken } from '../pricing';
import { limitRelayAddress } from '../rate-limit';
import { relayerAddress } from '../secrets';
import type { RelayJob } from '../sender';
import type { RequestContext } from '../types';

/** A deadline must be more than 60 seconds after now, so the batch can still land. */
const DEADLINE_MIN_S = 60;
/** A deadline must be at most 24 hours after now, plus 5 minutes of clock slack. */
const DEADLINE_MAX_S = 24 * 60 * 60 + 5 * 60;
/** secp256k1n / 2. A node skips an authorization with a larger `s`, and then the simulation checks nothing. */
const HALF_CURVE_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
/** The most calls that one batch can have. */
const MAX_CALLS = 8;
/** The low 64 bits of a Calibur nonce are the sequence of its key. */
const SEQUENCE_MASK = (1n << 64n) - 1n;

interface RelayRequest {
  chainId: number;
  evmAddress: Hex;
  /** The calls of the batch, in the order that the wallet signed them. */
  calls: BatchCall[];
  /** The full Calibur nonce: `key << 64 | sequence`. */
  batchNonce: bigint;
  salt: Hex;
  /** Unix seconds. */
  deadline: number;
  signature: Hex;
  authorization: RelayAuthorization | null;
}

const badSignature = (message: string): ApiError => new ApiError(400, 'bad_signature', message);
const stale = (message: string): ApiError => new ApiError(409, 'stale_request', message);
const feeTooLow = (message: string): ApiError => new ApiError(400, 'fee_too_low', message);

/** Run a parse. A ParseError is a malformed request. POST /v1/quote uses it too. */
export function parsed<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ParseError) throw invalidRequest(error.message);
    throw error;
  }
}

function parseAuthorization(value: unknown): RelayAuthorization | null {
  if (value === undefined) return null;
  const fields = shape(value, 'authorization', ['address', 'chainId', 'nonce', 'r', 's', 'yParity']);
  const { yParity } = fields;
  if (yParity !== 0 && yParity !== 1) fail('authorization.yParity', 'must be 0 or 1');
  return {
    address: address(fields.address, 'authorization.address'),
    chainId: safeInteger(fields.chainId, 'authorization.chainId', 0),
    nonce: safeInteger(fields.nonce, 'authorization.nonce', 0),
    r: hexBytes(fields.r, 'authorization.r', 32),
    s: hexBytes(fields.s, 'authorization.s', 32),
    yParity
  };
}

/** One call of `calls`. POST /v1/quote uses it too. */
export function parseCall(value: unknown, path: string): BatchCall {
  const fields = shape(value, path, ['to', 'value', 'data']);
  return {
    to: address(fields.to, `${path}.to`),
    value: amount(fields.value, `${path}.value`),
    data: hexData(fields.data, `${path}.data`)
  };
}

/** The `calls` list: 1 to MAX_CALLS calls, in the order of the request. */
function parseCalls(value: unknown): BatchCall[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CALLS) {
    fail('calls', `must be an array of 1 to ${MAX_CALLS} calls`);
  }
  return value.map((call: unknown, index) => parseCall(call, `calls.${index}`));
}

function parseRequest(body: Record<string, unknown>): RelayRequest {
  const required = ['chainId', 'evmAddress', 'calls', 'batchNonce', 'salt', 'deadline', 'signature'];
  const fields = shape(body, 'body', required, ['authorization']);
  return {
    chainId: safeInteger(fields.chainId, 'chainId', 1),
    evmAddress: address(fields.evmAddress, 'evmAddress'),
    calls: parseCalls(fields.calls),
    batchNonce: amount(fields.batchNonce, 'batchNonce'),
    salt: hexBytes(fields.salt, 'salt', 32),
    deadline: safeInteger(fields.deadline, 'deadline', 1),
    signature: hexBytes(fields.signature, 'signature', 65),
    authorization: parseAuthorization(fields.authorization)
  };
}

function checkEnvelope(request: RelayRequest, relayer: Hex): void {
  if (request.evmAddress === relayer) throw invalidRequest('evmAddress must not be the relayer.');
  if (!isRelayNonce(request.batchNonce)) throw invalidRequest('batchNonce does not have the relay nonce key.');
  const now = Math.floor(Date.now() / 1000);
  if (request.deadline <= now + DEADLINE_MIN_S || request.deadline > now + DEADLINE_MAX_S) {
    throw stale('The deadline is too near or too far. Sign again.');
  }
}

/**
 * Check the form of the fee call: a fee call to the chain's fee recipient in a fee token of the chain. Return the fee
 * with its token in lower case. The amount needs the estimate and the prices, so `checkFeeAmount` checks it after the
 * chain read.
 */
function checkFeeCall(chain: ChainConfig, call: BatchCall): RelayFee {
  const fee = readFeeCall(call);
  if (fee === null) throw feeTooLow('The last call of the batch must pay the fee.');
  if (fee.recipient.toLowerCase() !== chain.feeRecipient) throw feeTooLow('The fee must go to the fee recipient.');
  const token: Hex = `0x${fee.token.slice(2).toLowerCase()}`;
  if (!isFeeToken(chain, token)) {
    throw new ApiError(400, 'fee_token_not_accepted', 'The chain takes no fee in the token.');
  }
  return { ...fee, token };
}

/**
 * Apply the fee rule of the gas mode. Return the calls that the target rule checks, and the fee of a `deduct` batch.
 * In `deduct` mode the last call is the fee call: after its check, the target rule does not apply to it.
 */
function feeCheckedCalls(
  gasMode: GasMode,
  chain: ChainConfig,
  calls: BatchCall[]
): { checked: BatchCall[]; fee: RelayFee | null } {
  switch (gasMode) {
    case 'sponsor':
      return { checked: calls, fee: null };
    case 'deduct': {
      const feeCall = calls[calls.length - 1];
      if (calls.length < 2 || feeCall === undefined) {
        throw invalidRequest('A deduct batch needs a call before the fee call.');
      }
      return { checked: calls.slice(0, -1), fee: checkFeeCall(chain, feeCall) };
    }
  }
}

/**
 * The fee rule: the signed fee must be at least the fee of the Worker's own estimate of the signed batch, minus
 * FEE_TOLERANCE_PERCENT, at the gas price that the Sender signs with now. Else `fee_too_low` carries the fee that the
 * Worker would quote now, so the wallet can show it and sign again.
 */
async function checkFeeAmount(
  context: RequestContext,
  chain: ChainConfig,
  fee: RelayFee,
  state: RelayState,
  gas: bigint
): Promise<void> {
  const tokenDecimals = state.feeTokenDecimals;
  if (tokenDecimals === undefined) throw new Error('The relay read has no decimals of the fee token.');
  const exact = await feeIn(context.prices, chain, fee.token, { gas, maxFeePerGas: maxFeeOf(state), tokenDecimals });
  if (fee.amount >= minimumFee(exact)) return;
  throw new ApiError(400, 'fee_too_low', 'The fee is below the fee of the gas cost now. Review the fee again.', {
    required: quotedFee(exact).toString(),
    token: fee.token
  });
}

/** When the chain has `allowedTargets`, every call must go to one of them. POST /v1/quote uses it too. */
export function checkTargets(chain: ChainConfig, calls: readonly BatchCall[]): void {
  const allowed = chain.allowedTargets;
  if (allowed === null) return;
  if (calls.some(call => !allowed.includes(`0x${call.to.slice(2).toLowerCase()}`))) {
    throw new ApiError(400, 'target_not_allowed', 'A call goes to an address that the chain does not allow.');
  }
}

async function checkSignature(chain: ChainConfig, envelope: BatchEnvelope, calls: BatchCall[], signature: Hex) {
  let signer: string;
  try {
    signer = await recoverBatchSigner(chain.calibur, envelope, calls, signature);
  } catch {
    throw badSignature('The signature does not verify.');
  }
  if (signer.toLowerCase() !== envelope.evmAddress) throw badSignature('The batch is not signed by evmAddress.');
}

async function checkAuthorization(chain: ChainConfig, authorization: RelayAuthorization, evmAddress: Hex) {
  const pinned =
    authorization.address === chain.calibur.address &&
    authorization.chainId === chain.chainId &&
    BigInt(authorization.s) <= HALF_CURVE_ORDER;
  if (!pinned) throw badSignature('The authorization is not for the pinned Calibur on this chain.');
  let authority: string;
  try {
    authority = await recoverAuthorizationAddress({ authorization });
  } catch {
    throw badSignature('The authorization does not verify.');
  }
  if (authority.toLowerCase() !== evmAddress) throw badSignature('The authorization is not signed by evmAddress.');
}

async function readChain(
  context: RequestContext,
  chain: ChainConfig,
  call: RelayCall,
  fee: RelayFee | null
): Promise<RelayState> {
  try {
    // Sponsor mode reads exactly what it read before: no fee token.
    return await (fee === null
      ? context.reader.readRelay(chain, call)
      : context.reader.readRelay(chain, call, fee.token));
  } catch (error) {
    if (error instanceof RpcUnavailableError) {
      throw new ApiError(502, 'rpc_unavailable', 'The chain RPC does not answer.');
    }
    if (error instanceof ChainIntegrityError) {
      // A fixed text only: no address, no chain value and no secret.
      console.error(`evm-relay: ${error.message}`);
      throw new ApiError(503, 'service_unavailable', 'The service is not available.');
    }
    throw error;
  }
}

/** The authorization to send: none when the address already delegates to the pinned Calibur. */
function authorizationToSend(state: RelayState, supplied: RelayAuthorization | null): RelayAuthorization | null {
  if (state.delegated) return null;
  if (supplied === null) throw stale('The address does not delegate to Calibur. Sign an authorization.');
  if (supplied.nonce !== state.authorizationNonce) throw stale('The authorization nonce is out of date. Sign again.');
  return supplied;
}

/**
 * The batch must use the sequence that Calibur expects now. A lower sequence was used by an earlier batch, and a
 * higher one is not reached yet. The simulation of such a batch reverts, so this check runs before the estimate is
 * judged: the wallet then reads the account again and signs again.
 */
function checkSequence(state: RelayState, batchNonce: bigint): void {
  if ((batchNonce & SEQUENCE_MASK) !== state.sequence) {
    throw stale('The batch nonce is not the current Calibur sequence. Read the account and sign again.');
  }
}

/** The body of both relay routes. */
export function answer(job: RelayJob): Response {
  return json({ id: job.id, state: job.state, txHash: job.txHash });
}

export async function relay(context: RequestContext): Promise<Response> {
  const body = await readJson(context.request);
  const request = parsed(() => parseRequest(body));
  const config = routeConfig(context.env);
  const relayer = relayerAddress(context.env);
  if (relayer === null) throw notConfigured();

  const chain = config.chains.get(request.chainId);
  if (chain === undefined) throw new ApiError(400, 'unsupported_chain', 'The chain is not supported.');
  checkEnvelope(request, relayer);
  const { checked, fee } = feeCheckedCalls(config.gasMode, chain, request.calls);
  checkTargets(chain, checked);

  // The batch has the calls exactly as the request sends them, in the same order.
  const { calls, evmAddress, signature } = request;
  const envelope: BatchEnvelope = {
    chainId: chain.chainId,
    evmAddress,
    executor: relayer,
    batchNonce: request.batchNonce,
    salt: request.salt,
    deadline: BigInt(request.deadline)
  };
  await checkSignature(chain, envelope, calls, signature);
  const digest = batchDigest(chain.calibur, envelope, calls);
  const id: Hex = `0x${digest.slice(2).toLowerCase()}`;
  if (request.authorization !== null) await checkAuthorization(chain, request.authorization, evmAddress);

  await limitRelayAddress(context, evmAddress);
  const sender = context.senders(chain.chainId);
  const known = await sender.get(id);
  if (known !== null) return answer(known);

  const data = encodeExecution(envelope, calls, signature);
  const relayCall: RelayCall = { evmAddress, relayer, data, authorization: request.authorization };
  const state = await readChain(context, chain, relayCall, fee);
  const authorization = authorizationToSend(state, request.authorization);
  checkSequence(state, request.batchNonce);
  if (state.gasEstimate === null) throw new ApiError(409, 'simulation_failed', 'The batch fails in simulation.');
  // The fee pays for the estimate. The gas limit has 20 % more, which a mined transaction does not use.
  if (fee !== null) await checkFeeAmount(context, chain, fee, state, state.gasEstimate);
  const gas = state.gasEstimate + state.gasEstimate / 5n;
  const maxFeePerGas = maxFeeOf(state);
  if (state.relayerBalance < gas * maxFeePerGas) {
    // A fixed text and the chain id only.
    console.error(`evm-relay: the relayer account cannot pay the gas on chain ${chain.chainId}.`);
    throw new ApiError(503, 'relayer_unfunded', 'The relayer cannot pay the gas now. Try again later.');
  }

  const outcome = await sender.submit({
    id,
    chainId: chain.chainId,
    evmAddress,
    data,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas: state.priorityFee,
    authorization,
    deadline: request.deadline,
    chainNonce: state.relayerNonce
  });
  switch (outcome.status) {
    case 'job':
      return answer(outcome.job);
    case 'busy':
      throw new ApiError(409, 'busy', 'Another relay of the address is open.', { id: outcome.id });
  }
}
