// GET /v1/relay/{id}: the state of a stored relay. The id does not name its chain, so the route asks the Sender of each
// configured chain in config order, or only the chain of the `chainId` query. It reads the Sender storage only, never
// the chain.
import { chainOf } from './account';
import { answer } from './relay';
import { routeConfig } from '../config';
import { ApiError } from '../errors';
import type { Hex } from '../parse';
import type { RequestContext } from '../types';

export async function relayStatus(context: RequestContext, id: Hex): Promise<Response> {
  const config = routeConfig(context.env);
  const query = context.url.searchParams.get('chainId');
  const chainIds = query === null ? [...config.chains.keys()] : [chainOf(config, query).chainId];
  for (const chainId of chainIds) {
    const job = await context.senders(chainId).get(id);
    if (job !== null) return answer(job);
  }
  throw new ApiError(404, 'not_found', 'The relay does not exist.');
}
