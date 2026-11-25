import type { ChainReader } from './chain';
import { ApiError, notFound } from './errors';
import type { Hex } from './parse';
import { limitRead, limitRelay } from './rate-limit';
import { account } from './routes/account';
import { healthz } from './routes/health';
import { relay } from './routes/relay';
import { relayStatus } from './routes/relay-status';
import type { SenderDirectory } from './sender';
import type { Env, Handler, RequestContext } from './types';

const RELAY_STATUS_PATH = /^\/v1\/relay\/([^/]+)$/;
/** A relay id: the EIP-712 digest of the batch. */
const RELAY_ID = /^0x[0-9a-fA-F]{64}$/;

type Route = { name: 'healthz' | 'account' | 'relay' } | { name: 'relayStatus'; id: Hex };

const ALLOWED_METHODS: Readonly<Record<Route['name'], string>> = {
  healthz: 'GET',
  account: 'GET',
  relay: 'POST',
  relayStatus: 'GET'
};

function matchRelayStatus(pathname: string): Route {
  const id = RELAY_STATUS_PATH.exec(pathname)?.[1];
  if (id === undefined || !RELAY_ID.test(id)) throw notFound();
  return { name: 'relayStatus', id: `0x${id.slice(2).toLowerCase()}` };
}

function matchRoute(pathname: string): Route {
  switch (pathname) {
    case '/healthz':
      return { name: 'healthz' };
    case '/v1/account':
      return { name: 'account' };
    case '/v1/relay':
      return { name: 'relay' };
    default:
      return matchRelayStatus(pathname);
  }
}

/** Run the rate limit, then the handler. */
function limited(limit: (context: RequestContext) => Promise<void>, handler: Handler): Handler {
  return async context => {
    await limit(context);
    return handler(context);
  };
}

function handlerFor(route: Route): Handler {
  switch (route.name) {
    case 'healthz':
      return healthz;
    case 'account':
      return limited(limitRead, account);
    case 'relay':
      return limited(limitRelay, relay);
    case 'relayStatus': {
      const { id } = route;
      return limited(limitRead, context => relayStatus(context, id));
    }
  }
}

/** Match the route, check the method, and run the handler. */
export async function dispatch(
  request: Request,
  env: Env,
  reader: ChainReader,
  senders: SenderDirectory
): Promise<Response> {
  const url = new URL(request.url);
  const route = matchRoute(url.pathname);
  const allow = ALLOWED_METHODS[route.name];
  if (request.method !== allow) {
    throw new ApiError(405, 'method_not_allowed', `The route allows only: ${allow}.`, {}, { Allow: allow });
  }
  return handlerFor(route)({ request, env, url, reader, senders });
}
