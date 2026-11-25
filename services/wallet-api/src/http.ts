import { MAX_BODY_BYTES, isRecord } from './constants';
import { ApiError, badRequest, tooLarge } from './errors';
import type { ErrorBody } from './types';

const NO_STORE: Record<string, string> = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const PREFLIGHT_METHODS: ReadonlySet<string> = new Set(['GET', 'POST', 'PUT', 'DELETE']);
const PREFLIGHT_HEADERS: ReadonlySet<string> = new Set(['authorization', 'content-type', 'if-none-match']);

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

export function emptyResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { ...NO_STORE, ...headers } });
}

export function notModified(etag: string): Response {
  return emptyResponse(304, { ETag: `"${etag}"` });
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
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw tooLarge('The request body is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw badRequest('The request body is missing.');
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge('The request body is too large.');
    }
    text += decoder.decode(part.value, { stream: true });
  }
  text += decoder.decode();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw badRequest('The request body is not valid JSON.');
  }
  if (!isRecord(value)) throw badRequest('The request body must be a JSON object.');
  return value;
}

/** Refuse an object that does not have exactly these keys. */
export function expectKeys(value: Record<string, unknown>, keys: readonly string[], what: string): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw badRequest(`The ${what} must have exactly these fields: ${keys.join(', ')}.`);
  }
}

/** The entity tags of If-None-Match, without quotes, or null. */
export function ifNoneMatch(request: Request): Set<string> | null {
  const header = request.headers.get('If-None-Match');
  if (header === null) return null;
  const tags = header
    .split(',')
    .map(part => part.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1'))
    .filter(tag => tag.length > 0);
  return tags.length > 0 ? new Set(tags) : null;
}

export function parseOrigins(allowedOrigins: string | undefined): Set<string> {
  const values: unknown = JSON.parse(allowedOrigins ?? '[]');
  if (!Array.isArray(values)) throw new Error('Invalid origin configuration');
  const origins = new Set<string>();
  values.forEach((value: unknown) => {
    if (typeof value !== 'string' || !value || value.includes('*')) throw new Error('Invalid origin configuration');
    origins.add(value);
  });
  return origins;
}

/** The CORS headers for an allowed origin, or only Vary for a request with no origin. */
export function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = { Vary: 'Origin' };
  if (origin !== null) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Expose-Headers'] = 'ETag';
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
      error: 'forbidden',
      message: 'The preflight asks for a method or header that the API does not allow.'
    };
    return json(body, 403);
  }
  return emptyResponse(204, {
    'Access-Control-Allow-Methods': [...PREFLIGHT_METHODS].join(', '),
    'Access-Control-Allow-Headers': [...PREFLIGHT_HEADERS].join(', '),
    'Access-Control-Max-Age': '600'
  });
}
