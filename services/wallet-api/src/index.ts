import { corsHeaders, errorResponse, json, parseOrigins, preflight, withHeaders } from './http';
import { dispatch } from './router';
import type { Env, ErrorBody } from './types';

export interface Service {
  fetch(request: Request, env: Env): Promise<Response>;
}

/** Create the service. Tests can give their own clock. */
export function createService({ now = Date.now }: { now?: () => number } = {}): Service {
  return {
    async fetch(request, env) {
      let origins: Set<string>;
      try {
        origins = parseOrigins(env.ALLOWED_ORIGINS);
      } catch {
        return json({ error: 'service_unavailable', message: 'The service is not configured.' } satisfies ErrorBody, 503);
      }
      const origin = request.headers.get('Origin');
      if (origin !== null && !origins.has(origin)) {
        return json({ error: 'forbidden', message: 'The origin is not allowed.' } satisfies ErrorBody, 403, { Vary: 'Origin' });
      }
      const headers = corsHeaders(origin);
      if (request.method === 'OPTIONS') return withHeaders(preflight(request), headers);
      let response: Response;
      try {
        response = await dispatch(request, env, now);
      } catch (error) {
        response = errorResponse(error);
      }
      return withHeaders(response, headers);
    }
  };
}

const service = createService();

export default {
  fetch: (request: Request, env: Env): Promise<Response> => service.fetch(request, env)
} satisfies ExportedHandler<Env>;
