import { createRpcReader, type ChainReader } from './chain';
import { ConfigError, parseOrigins } from './config';
import { corsHeaders, errorResponse, json, preflight, withHeaders } from './http';
import { createPriceSource, type PriceSource } from './prices';
import { dispatch } from './router';
import { durableSenders, type SenderDirectory } from './sender';
import type { Env, ErrorBody } from './types';

function allowedOrigins(env: Env): Set<string> | null {
  try {
    return parseOrigins(env.ALLOWED_ORIGINS);
  } catch (error) {
    if (error instanceof ConfigError) return null;
    throw error;
  }
}

/**
 * The CORS gate, then the dispatch. Every error leaves as a JSON error body. The tests pass a fake reader, Senders
 * over node:sqlite and fake prices.
 */
export async function handleRequest(
  request: Request,
  env: Env,
  reader: ChainReader = createRpcReader(env),
  senders: SenderDirectory = durableSenders(env),
  prices: PriceSource = createPriceSource()
): Promise<Response> {
  const origins = allowedOrigins(env);
  if (origins === null) {
    return json({ error: 'service_unavailable', message: 'The service is not configured.' } satisfies ErrorBody, 503);
  }
  const origin = request.headers.get('Origin');
  if (origin !== null && !origins.has(origin)) {
    const body: ErrorBody = { error: 'origin_not_allowed', message: 'The origin is not allowed.' };
    return json(body, 403, { Vary: 'Origin' });
  }
  const headers = corsHeaders(origin);
  if (request.method === 'OPTIONS') return withHeaders(preflight(request), headers);
  let response: Response;
  try {
    response = await dispatch(request, env, reader, senders, prices);
  } catch (error) {
    response = errorResponse(error);
  }
  return withHeaders(response, headers);
}

export default {
  // A wrapper, because the runtime passes the execution context as the third argument.
  fetch: (request: Request, env: Env) => handleRequest(request, env)
} satisfies ExportedHandler<Env>;
