import { isRecord } from 'lib/update/guards';

/** The part of a fetch response a bounded read uses. Headers and text() are optional, as in a minimal stub or polyfill. */
export interface JsonResponse {
  ok: boolean;
  headers?: { get(name: string): string | null };
  text?(): Promise<string>;
  json(): Promise<unknown>;
}

export type JsonFetch = (
  url: string,
  init: { cache: 'no-store'; headers: { Accept: string }; signal: AbortSignal }
) => Promise<JsonResponse>;

/**
 * Runs `run` with a signal that aborts after `ms`, and clears the timer once `run` settles. It stands
 * in for `AbortSignal.timeout`, which iOS 15 WebKit and Safari before 16 lack. The signal ends only
 * what it is passed to, so `run` covers the whole request, its body read included.
 */
export async function withRequestTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The JSON document at `url`, bypassing the browser cache, with the request and its body read
 * bounded by `timeoutMs`. Rejects a failed response, a body over `maxBytes` and a body that is not
 * JSON. A response without text() is read through json(), unmeasured.
 */
export function fetchBoundedJson(
  fetchFn: JsonFetch,
  url: string,
  { maxBytes, timeoutMs }: { maxBytes: number; timeoutMs: number }
): Promise<unknown> {
  return withRequestTimeout(timeoutMs, async signal => {
    const response = await fetchFn(url, { cache: 'no-store', headers: { Accept: 'application/json' }, signal });
    if (!response.ok) throw new Error('Remote JSON request failed');
    // The declared length is the cheap rejection; the body is measured too, because a chunked or
    // re-encoded response declares nothing useful.
    if (Number(response.headers?.get('content-length') ?? '0') > maxBytes) {
      throw new Error('Remote JSON response is too large');
    }
    if (!response.text) return response.json();
    const raw = await response.text();
    if (raw.length > maxBytes) throw new Error('Remote JSON response is too large');
    const body: unknown = JSON.parse(raw);
    return body;
  });
}

/** A stored `{ fetchedAt, body }` entry, or `null` for anything else. How old one may be is the caller's rule. */
export function readTimestampedEntry(value: unknown): { fetchedAt: number; body: unknown } | null {
  if (!isRecord(value) || typeof value.fetchedAt !== 'number' || !('body' in value)) return null;
  return { fetchedAt: value.fetchedAt, body: value.body };
}
