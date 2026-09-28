import { isRecord } from 'lib/update/guards';

/** The part of a fetch response a bounded read uses. All but ok and json() are optional, as in a stub or polyfill. */
export interface JsonResponse {
  ok: boolean;
  status?: number;
  headers?: { get(name: string): string | null };
  body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } } | null;
  text?(): Promise<string>;
  json(): Promise<unknown>;
}

export type JsonFetch = (
  url: string,
  init: { cache: 'no-store'; headers: { Accept: string }; signal: AbortSignal }
) => Promise<JsonResponse>;

/**
 * The reason a request timer aborts with after `ms`, named as `AbortSignal.timeout` names it, so a
 * caller's error says the request timed out.
 */
export function requestTimeoutError(ms: number): DOMException {
  return new DOMException(`Request timed out after ${ms} ms`, 'TimeoutError');
}

/**
 * Runs `run` with a signal that aborts after `ms`. Once `run` settles it clears the timer and aborts the
 * signal, which ends any body `run` left unread and is a no-op for one it read. It stands in for
 * `AbortSignal.timeout`, which iOS 15 WebKit and Safari before 16 lack. The signal ends only what it is
 * passed to, so `run` covers the whole request, its body read included.
 */
export async function withRequestTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(requestTimeoutError(ms)), ms);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

const tooLarge = () => new Error('Remote JSON response is too large');

/** The body as text, refused once it passes `maxBytes` bytes; `null` for a response that offers only json(). */
async function readCappedText(response: JsonResponse, maxBytes: number): Promise<string | null> {
  if (response.body) {
    const reader = response.body.getReader();
    // One streaming decoder, so a character split across chunks decodes whole.
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = '';
    let chunk = await reader.read();
    while (!chunk.done) {
      bytes += chunk.value?.byteLength ?? 0;
      // The abort once the request settles ends the rest of the stream.
      if (bytes > maxBytes) throw tooLarge();
      text += decoder.decode(chunk.value, { stream: true });
      chunk = await reader.read();
    }
    return text + decoder.decode();
  }
  if (!response.text) return null;
  const text = await response.text();
  // Bytes, not UTF-16 units, which undercount every character outside ASCII.
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw tooLarge();
  return text;
}

/**
 * The JSON document at `url`, bypassing the browser cache, with the request and its body read
 * bounded by `timeoutMs`. Rejects a failed response, a body over `maxBytes` and a body that is not
 * JSON. A body stream is measured as it is read; a response with neither a stream nor text() is
 * read through json(), unmeasured.
 */
export function fetchBoundedJson(
  fetchFn: JsonFetch,
  url: string,
  { maxBytes, timeoutMs }: { maxBytes: number; timeoutMs: number }
): Promise<unknown> {
  return withRequestTimeout(timeoutMs, async signal => {
    const response = await fetchFn(url, { cache: 'no-store', headers: { Accept: 'application/json' }, signal });
    if (!response.ok) {
      const status = response.status === undefined ? '' : ` with HTTP ${response.status}`;
      throw new Error(`Remote JSON request failed${status}`);
    }
    // The declared length is the cheap rejection; the body is measured too, because a chunked or
    // re-encoded response declares nothing useful.
    if (Number(response.headers?.get('content-length') ?? '0') > maxBytes) throw tooLarge();
    const raw = await readCappedText(response, maxBytes);
    if (raw === null) return response.json();
    const body: unknown = JSON.parse(raw);
    return body;
  });
}

/** A stored `{ fetchedAt, body }` entry, or `null` for anything else. How old one may be is the caller's rule. */
export function readTimestampedEntry(value: unknown): { fetchedAt: number; body: unknown } | null {
  if (!isRecord(value) || typeof value.fetchedAt !== 'number' || !('body' in value)) return null;
  return { fetchedAt: value.fetchedAt, body: value.body };
}
