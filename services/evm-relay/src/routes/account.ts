// GET /v1/account: the balances of a deposit address and the values that the wallet needs to sign a batch.
import { ChainIntegrityError, RpcUnavailableError, type AccountState } from '../chain';
import { ConfigError, parseConfig, type ChainConfig, type Hex, type RelayConfig } from '../config';
import { ApiError, invalidRequest, notConfigured } from '../errors';
import { json } from '../http';
import { kindsOf } from '../kinds';
import { limitReadAddress } from '../rate-limit';
import { relayerAddress } from '../secrets';
import type { AccountResponse, RequestContext } from '../types';

const CHAIN_ID = /^[1-9][0-9]{0,15}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** The browser may keep the answer for 5 seconds. The wallet polls the route. */
const CACHE_CONTROL = 'private, max-age=5';

function configOf(context: RequestContext): RelayConfig {
  try {
    return parseConfig(context.env);
  } catch (error) {
    if (error instanceof ConfigError) throw notConfigured();
    throw error;
  }
}

function chainOf(config: RelayConfig, value: string | null): ChainConfig {
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

async function readState(context: RequestContext, chain: ChainConfig, address: Hex): Promise<AccountState> {
  try {
    return await context.reader.readAccount(chain, address, kindsOf(chain.kinds));
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
  const config = configOf(context);
  const { searchParams } = context.url;
  const chain = chainOf(config, searchParams.get('chainId'));
  const executor = relayerAddress(context.env);
  if (executor === null) throw notConfigured();
  const address = addressOf(searchParams.get('address'), executor);
  await limitReadAddress(context, address);
  const state = await readState(context, chain, address);

  // In sponsor mode the relayer pays the gas, so no token fee applies whatever the config holds.
  const sponsored = config.gasMode === 'sponsor';
  const kinds: AccountResponse['kinds'] = {};
  for (const [kind, sequence] of state.sequences) kinds[kind] = { sequence: sequence.toString() };
  const body: AccountResponse = {
    chainId: chain.chainId,
    address,
    mode: config.gasMode,
    executor,
    feeRecipient: sponsored ? null : chain.feeRecipient,
    needsAuthorization: !state.delegated,
    authorizationNonce: state.authorizationNonce,
    salt: state.salt,
    kinds,
    balances: [...chain.tokens].map(([token, policy], index) => {
      const balance = state.balances[index];
      if (balance === undefined) throw new Error('The reader returned fewer balances than tokens.');
      const fee = sponsored ? '0' : policy.fee.toString();
      return { token, balance: balance.toString(), minAmount: policy.minAmount.toString(), fee };
    })
  };
  return json(body, 200, { 'Cache-Control': CACHE_CONTROL });
}
