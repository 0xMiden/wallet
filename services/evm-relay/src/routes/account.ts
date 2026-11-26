// GET /v1/account: the values that the wallet needs to sign a batch, and the balances of the tokens it asks for.
import { ChainIntegrityError, RpcUnavailableError, type AccountState } from '../chain';
import { routeConfig, type ChainConfig, type Hex, type RelayConfig } from '../config';
import { ApiError, invalidRequest, notConfigured } from '../errors';
import { json } from '../http';
import { limitReadAddress } from '../rate-limit';
import { relayerAddress } from '../secrets';
import type { AccountResponse, RequestContext } from '../types';

const CHAIN_ID = /^[1-9][0-9]{0,15}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** The most tokens that one read can ask for. */
const MAX_TOKENS = 16;
/** The browser may keep the answer for 5 seconds. The wallet polls the route. */
const CACHE_CONTROL = 'private, max-age=5';

/** The chain of a `chainId` query value. GET /v1/relay/{id} uses it too. */
export function chainOf(config: RelayConfig, value: string | null): ChainConfig {
  const chainId = Number(value);
  if (value === null || !CHAIN_ID.test(value) || !Number.isSafeInteger(chainId)) {
    throw invalidRequest('chainId must be a positive decimal integer.');
  }
  const chain = config.chains.get(chainId);
  if (chain === undefined) throw new ApiError(400, 'unsupported_chain', 'The chain is not supported.');
  return chain;
}

function addressOf(value: string | null, executor: Hex): Hex {
  if (value === null || !ADDRESS.test(value)) throw invalidRequest('address must be a 20-byte hex address.');
  const address: Hex = `0x${value.slice(2).toLowerCase()}`;
  if (address === executor) throw invalidRequest('address must not be the relayer.');
  return address;
}

/**
 * The tokens of the `tokens` query: a comma list of 1 to 16 distinct addresses, in lower case. The zero address is the
 * native coin. No `tokens` parameter means no token.
 */
function tokensOf(values: string[]): Hex[] {
  const [value] = values;
  if (value === undefined) return [];
  if (values.length > 1) throw invalidRequest('tokens must be given once.');
  const items = value.split(',');
  if (items.length > MAX_TOKENS) throw invalidRequest(`tokens must name at most ${MAX_TOKENS} tokens.`);
  const tokens: Hex[] = [];
  for (const item of items) {
    if (!ADDRESS.test(item)) throw invalidRequest('tokens must be 20-byte hex addresses.');
    const token: Hex = `0x${item.slice(2).toLowerCase()}`;
    if (tokens.includes(token)) throw invalidRequest('tokens must not repeat a token.');
    tokens.push(token);
  }
  return tokens;
}

async function readState(
  context: RequestContext,
  chain: ChainConfig,
  address: Hex,
  tokens: readonly Hex[]
): Promise<AccountState> {
  try {
    return await context.reader.readAccount(chain, address, tokens);
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

export async function account(context: RequestContext): Promise<Response> {
  const config = routeConfig(context.env);
  const { searchParams } = context.url;
  const chain = chainOf(config, searchParams.get('chainId'));
  const executor = relayerAddress(context.env);
  if (executor === null) throw notConfigured();
  const address = addressOf(searchParams.get('address'), executor);
  const tokens = tokensOf(searchParams.getAll('tokens'));
  await limitReadAddress(context, address);
  const state = await readState(context, chain, address, tokens);

  // In sponsor mode the relayer pays the gas, so no token fee applies whatever the config holds.
  const sponsored = config.gasMode === 'sponsor';
  const body: AccountResponse = {
    chainId: chain.chainId,
    address,
    mode: config.gasMode,
    executor,
    feeRecipient: sponsored ? null : chain.feeRecipient,
    needsAuthorization: !state.delegated,
    authorizationNonce: state.authorizationNonce,
    salt: state.salt,
    sequence: state.sequence.toString(),
    fees: sponsored ? [] : [...chain.fees].map(([token, fee]) => ({ token, fee: fee.toString() })),
    allowedTargets: chain.allowedTargets === null ? null : [...chain.allowedTargets],
    balances: tokens.map((token, index) => {
      const balance = state.balances[index];
      if (balance === undefined) throw new Error('The reader returned fewer balances than tokens.');
      return { token, balance: balance.toString() };
    })
  };
  return json(body, 200, { 'Cache-Control': CACHE_CONTROL });
}
