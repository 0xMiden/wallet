// GET /v1/chains: the chains that the Worker serves, the gas mode and the relayer address. The wallet reads it when
// the Deposit flow opens, so it does not show a deposit address for a chain that the relay does not serve. The route
// makes no RPC call.
import { routeConfig } from '../config';
import { notConfigured } from '../errors';
import { json } from '../http';
import { relayerAddress } from '../secrets';
import type { ChainsResponse, RequestContext } from '../types';

/** The browser may keep the answer for 60 seconds. The served chains change only on a deploy. */
const CACHE_CONTROL = 'private, max-age=60';

export function chains(context: RequestContext): Response {
  // The account route and the relay routes use the same parse, so a listed chain is never `unsupported_chain` there.
  const config = routeConfig(context.env);
  const executor = relayerAddress(context.env);
  if (executor === null) throw notConfigured();
  const body: ChainsResponse = { mode: config.gasMode, executor, chains: [...config.chains.keys()] };
  return json(body, 200, { 'Cache-Control': CACHE_CONTROL });
}
