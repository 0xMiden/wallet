// POST /v1/relay: check a signed relay batch, simulate it and hand it to the Sender of its chain. The checks run from
// the cheapest to the most expensive: the body, the chain, the envelope, the call rules, the signatures, the address
// rate limit, the stored relay and then the chain read. The route takes the calls as the wallet sends them and never
// builds a call. It never logs the body, a signature or an RPC URL.
import { recoverAuthorizationAddress } from 'viem/utils';

import {
  batchDigest,
  encodeExecution,
  isRelayNonce,
  readFeeCall,
  recoverBatchSigner,
  type BatchCall,
  type BatchEnvelope
} from '../../../../src/lib/evm-relay/batch';
import { RpcUnavailableError, maxFeeOf, type RelayAuthorization, type RelayCall, type RelayState } from '../chain';
import { routeConfig, type ChainConfig, type GasMode } from '../config';
import { ApiError, invalidRequest, notConfigured } from '../errors';
import { json, readJson } from '../http';
import { ParseError, address, amount, fail, hexBytes, hexData, safeInteger, shape, type Hex } from '../parse';
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

/** Run a parse. A ParseError is a malformed request. */
function parsed<T>(parse: () => T): T {
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

function parseCall(value: unknown, path: string): BatchCall {
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

/** Check that the call pays at least the configured fee of its token to the chain's fee recipient. */
function checkFee(chain: ChainConfig, call: BatchCall): void {
  const fee = readFeeCall(call);
  if (fee === null) throw feeTooLow('The last call of the batch must pay the fee.');
  if (fee.recipient.toLowerCase() !== chain.feeRecipient) throw feeTooLow('The fee must go to the fee recipient.');
  const configured = chain.fees.get(`0x${fee.token.slice(2).toLowerCase()}`);
  if (configured === undefined) throw feeTooLow('The chain takes no fee in the token.');
  if (fee.amount < configured) throw feeTooLow('The fee is below the configured fee.');
}

/**
 * Apply the fee rule of the gas mode. Return the calls that the target rule checks. In `deduct` mode the last call is
 * the fee call: after its check, the target rule does not apply to it.
 */
function feeCheckedCalls(gasMode: GasMode, chain: ChainConfig, calls: BatchCall[]): BatchCall[] {
  switch (gasMode) {
    case 'sponsor':
      return calls;
    case 'deduct': {
      const feeCall = calls[calls.length - 1];
      if (calls.length < 2 || feeCall === undefined) {
        throw invalidRequest('A deduct batch needs a call before the fee call.');
      }
      checkFee(chain, feeCall);
      return calls.slice(0, -1);
    }
  }
}

/** When the chain has `allowedTargets`, every call must go to one of them. */
function checkTargets(chain: ChainConfig, calls: readonly BatchCall[]): void {
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

async function readChain(context: RequestContext, chain: ChainConfig, call: RelayCall): Promise<RelayState> {
  try {
    return await context.reader.readRelay(chain, call);
  } catch (error) {
    if (error instanceof RpcUnavailableError) {
      throw new ApiError(502, 'rpc_unavailable', 'The chain RPC does not answer.');
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
  checkTargets(chain, feeCheckedCalls(config.gasMode, chain, request.calls));

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
  const state = await readChain(context, chain, { evmAddress, relayer, data, authorization: request.authorization });
  const authorization = authorizationToSend(state, request.authorization);
  if (state.gasEstimate === null) throw new ApiError(409, 'simulation_failed', 'The batch fails in simulation.');
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
