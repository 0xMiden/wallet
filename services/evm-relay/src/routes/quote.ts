// POST /v1/quote: the fee that a `deduct` batch must pay, before the wallet signs it. The route simulates the calls
// with a fee call at their end (quote-gas.ts), prices the gas in the fee token (pricing.ts) and adds QUOTE_MARGIN.
// The quote is not stored and not signed: the relay route decides again from its own simulation. The route never logs
// the body or an RPC URL.
import { buildFeeCall, type BatchCall } from '../../../../src/lib/evm-relay/batch';
import { ChainIntegrityError, RpcUnavailableError, maxFeeOf, type QuoteCall, type QuoteState } from '../chain';
import { routeConfig, type ChainConfig } from '../config';
import { ApiError, invalidRequest, notConfigured } from '../errors';
import { QUOTE_VALID_SECONDS, quotedFee } from '../fee';
import { json, readJson } from '../http';
import { address, fail, safeInteger, shape, type Hex } from '../parse';
import { feeIn, isFeeToken } from '../pricing';
import { calibrationFor, encodeSelfExecution, quoteGasOf } from '../quote-gas';
import { limitReadAddress } from '../rate-limit';
import { relayerAddress } from '../secrets';
import type { QuoteResponse, RequestContext } from '../types';
import { checkTargets, parseCall, parsed } from './relay';

/** The most calls of a quote request: the relay route takes 8, and the fee call is the 8th. */
const MAX_QUOTE_CALLS = 7;
/**
 * The fee amount of the simulated fee call. A real fee is at least 1, so a batch that can pay the real fee can pay
 * this one. quote-gas.ts adds the calldata of the real amount (VARIABLE_CALLDATA_BYTES).
 */
const SIMULATED_FEE = 1n;

interface QuoteRequest {
  chainId: number;
  evmAddress: Hex;
  calls: BatchCall[];
  /** Lower case. The zero address is the native coin. */
  feeToken: Hex;
  /** True or false when the request says; null: the chain decides (true when the address does not delegate). */
  authorization: boolean | null;
}

function parseRequest(body: Record<string, unknown>): QuoteRequest {
  const fields = shape(body, 'body', ['chainId', 'evmAddress', 'calls', 'feeToken'], ['authorization']);
  const { calls, authorization } = fields;
  if (!Array.isArray(calls) || calls.length === 0 || calls.length > MAX_QUOTE_CALLS) {
    fail('calls', `must be an array of 1 to ${MAX_QUOTE_CALLS} calls, without the fee call`);
  }
  if (authorization !== undefined && typeof authorization !== 'boolean') fail('authorization', 'must be a boolean');
  return {
    chainId: safeInteger(fields.chainId, 'chainId', 1),
    evmAddress: address(fields.evmAddress, 'evmAddress'),
    calls: calls.map((call: unknown, index) => parseCall(call, `calls.${index}`)),
    feeToken: address(fields.feeToken, 'feeToken', true),
    authorization: authorization ?? null
  };
}

async function readChain(context: RequestContext, chain: ChainConfig, call: QuoteCall): Promise<QuoteState> {
  try {
    return await context.reader.readQuote(chain, call);
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

export async function quote(context: RequestContext): Promise<Response> {
  const config = routeConfig(context.env);
  const relayer = relayerAddress(context.env);
  if (relayer === null) throw notConfigured();
  if (config.gasMode === 'sponsor') {
    throw new ApiError(400, 'fee_not_needed', 'The relayer pays the gas: a batch needs no fee.');
  }
  const body = await readJson(context.request);
  const request = parsed(() => parseRequest(body));
  const chain = config.chains.get(request.chainId);
  if (chain === undefined) throw new ApiError(400, 'unsupported_chain', 'The chain is not supported.');
  const recipient = chain.feeRecipient;
  // The config parse requires a fee recipient in deduct mode.
  if (recipient === null) throw notConfigured();
  if (request.evmAddress === relayer) throw invalidRequest('evmAddress must not be the relayer.');
  if (!isFeeToken(chain, request.feeToken)) {
    throw new ApiError(400, 'fee_token_not_accepted', 'The chain takes no fee in the token.');
  }
  checkTargets(chain, request.calls);
  await limitReadAddress(context, request.evmAddress);

  const calls = [...request.calls, buildFeeCall({ token: request.feeToken, recipient, amount: SIMULATED_FEE })];
  const data = encodeSelfExecution(calls);
  const calibration = await calibrationFor(chain, relayer);
  const state = await readChain(context, chain, {
    evmAddress: request.evmAddress,
    relayer,
    data,
    feeToken: request.feeToken,
    calibration
  });
  if (state.batchEstimate === null) throw new ApiError(409, 'simulation_failed', 'The batch fails in simulation.');
  const gas = quoteGasOf({
    batchEstimate: state.batchEstimate,
    calibration: state.calibration,
    authorization: request.authorization ?? !state.delegated,
    calls: calls.length,
    dataBytes: (data.length - 2) / 2
  });
  const exact = await feeIn(context.prices, chain, request.feeToken, {
    gas,
    maxFeePerGas: maxFeeOf(state),
    tokenDecimals: state.feeTokenDecimals
  });
  const answer: QuoteResponse = {
    chainId: chain.chainId,
    token: request.feeToken,
    recipient,
    fee: quotedFee(exact).toString(),
    gas: gas.toString(),
    validUntil: Math.floor(Date.now() / 1000) + QUOTE_VALID_SECONDS
  };
  return json(answer);
}
