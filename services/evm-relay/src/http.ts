import { ApiError, invalidRequest, tooLarge } from './errors';
import type { ErrorBody } from './types';

/** The largest request body, in bytes. A relay request is under 2 KiB. */
export const MAX_BODY_BYTES = 64 * 1024;

const NO_STORE: Record<string, string> = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const PREFLIGHT_METHODS: ReadonlySet<string> = new Set(['GET', 'POST']);
const PREFLIGHT_HEADERS: ReadonlySet<string> = new Set(['content-type']);

/** True for a JSON object that is not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function json<T extends object>(body: T, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    const body: ErrorBody = { error: error.code, message: error.message, ...error.extra };
    return json(body, error.status, error.headers);
  }
  return json({ error: 'internal_error', message: 'The request failed.' } satisfies ErrorBody, 500);
}

/** Add headers to a response. Keep its status and body. */
export function withHeaders(response: Response, headers: Record<string, string>): Response {
  const merged = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) merged.set(name, value);
  return new Response(response.body, { status: response.status, headers: merged });
}

/** Read a JSON object body. Refuse a body over MAX_BODY_BYTES before the parse. */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw tooLarge();
  const reader = request.body?.getReader();
  if (!reader) throw invalidRequest('The request body is missing.');
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    text += decoder.decode(part.value, { stream: true });
  }
  text += decoder.decode();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalidRequest('The request body is not valid JSON.');
  }
  if (!isRecord(value)) throw invalidRequest('The request body must be a JSON object.');
  return value;
}

/** The CORS headers for an allowed origin, or only Vary for a request with no origin. */
export function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = { Vary: 'Origin' };
  if (origin !== null) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Expose-Headers'] = 'Retry-After';
  }
  return headers;
}

/** Answer a CORS preflight. Allow only the methods and headers that the API uses. */
export function preflight(request: Request): Response {
  const method = request.headers.get('Access-Control-Request-Method') ?? '';
  const requested = (request.headers.get('Access-Control-Request-Headers') ?? '')
    .split(',')
    .map(name => name.trim().toLowerCase())
    .filter(name => name.length > 0);
  if (!PREFLIGHT_METHODS.has(method) || requested.some(name => !PREFLIGHT_HEADERS.has(name))) {
    const body: ErrorBody = {
      error: 'origin_not_allowed',
      message: 'The preflight asks for a method or header that the API does not allow.'
    };
    return json(body, 403);
  }
  return new Response(null, {
    status: 204,
    headers: {
      ...NO_STORE,
      'Access-Control-Allow-Methods': [...PREFLIGHT_METHODS].join(', '),
      'Access-Control-Allow-Headers': [...PREFLIGHT_HEADERS].join(', '),
      'Access-Control-Max-Age': '600'
    }
  });
}
