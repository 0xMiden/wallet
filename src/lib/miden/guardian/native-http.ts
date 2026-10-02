import { CapacitorHttp } from '@capacitor/core';

import { monotonicNowMs } from 'lib/miden/sync-backoff';
import { GUARDIAN_OPTIONS } from 'lib/miden-chain/constants';
import {
  getEffectiveNoteTransportUrl,
  getEffectiveProverUrl,
  getEffectiveRpcUrl
} from 'lib/miden-chain/effective-endpoints';
import { isMobile } from 'lib/platform';

/**
 * The Guardian fetch boundary, on every platform.
 *
 * `@openzeppelin/guardian-client` hardcodes global `fetch` with no injectable
 * transport and passes no signal, so the only seam we control is
 * `globalThis.fetch` itself. Requests whose origin matches a known Guardian
 * endpoint are routed; everything else passes through untouched.
 *
 * Every routed request is cut off after GUARDIAN_REQUEST_TIMEOUT_MS with
 * `GuardianRequestTimeoutError` (#312), and a caller's own abort still rejects
 * with the caller's reason. Unbounded, a proposal POST to a Guardian that
 * stopped answering held the WASM lock until the five-minute watchdog poisoned
 * the client and failed the send.
 *
 * On mobile a routed request goes through `CapacitorHttp.request()` (native
 * HTTP, not subject to CORS): Guardian operators don't emit
 * `Access-Control-Allow-Origin` for the Capacitor WebView origin. Scoping by
 * origin avoids Capacitor's global fetch-patching mode, which is known to break
 * binary responses (the SDK's gRPC-web/WASM fetches). Off mobile a routed
 * request keeps the original fetch; the extension reaches Guardians through host
 * permissions.
 *
 * So an origin the app itself fetches from (the page, the node RPC, the prover,
 * the note transport) is never routed, whoever registered it, judged per request.
 * And an endpoint not yet known to be a Guardian is routed only while a probe of
 * it is in flight (`probeGuardianOrigin`), so a URL that turns out not to be one
 * is not left routed for the session.
 *
 * The Guardian API is JSON-only, so rebuilding a `Response` from a buffered body
 * is lossless.
 */

/** Every routed Guardian request is cut off after this long (#312). */
export const GUARDIAN_REQUEST_TIMEOUT_MS = 60_000;

/**
 * A Guardian request the boundary cut off at its deadline. The transaction loop
 * recognizes it by `name` through a cause chain (`isGuardianRequestTimeout` in
 * ./serialize). Its message says "timed out", so the other Guardian error checks
 * read it as an unreachable Guardian.
 */
export class GuardianRequestTimeoutError extends Error {
  constructor(
    readonly url: string,
    readonly timeoutMs: number
  ) {
    super(`Guardian request to ${url} timed out after ${timeoutMs} ms`);
    this.name = 'GuardianRequestTimeoutError';
  }
}

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// Routed for the session: the built-ins, and endpoints bound to an account or proved to be a Guardian.
const guardianOrigins = new Set<string>();
// Routed only while probed: each origin's in-flight probes.
const probeHolds = new Map<string, Set<symbol>>();
// Response() rejects a non-null body for these statuses.
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * Seed the built-in guardian origins. Deferred from module-load to first
 * interceptor install: importing this module must not iterate GUARDIAN_OPTIONS
 * eagerly, or a `lib/miden-chain/constants` <-> native-http import cycle can
 * observe `GUARDIAN_OPTIONS` before it's initialized (undefined, so a throw at
 * import time, which breaks unrelated module graphs and unit tests).
 */
function seedBuiltinGuardianOrigins(): void {
  for (const option of GUARDIAN_OPTIONS ?? []) {
    for (const endpoint of option.endpoint.values()) {
      addOrigin(endpoint);
    }
  }
}

function parseOrigin(url: string): string | null {
  try {
    const { origin } = new URL(url);
    // A non-http(s) URL such as capacitor://localhost has the opaque origin "null", which all of them share.
    return origin === 'null' ? null : origin;
  } catch {
    // Not a parseable URL (a half-typed custom endpoint, a relative request URL): nothing to match.
    return null;
  }
}

function addOrigin(endpoint: string): void {
  const origin = parseOrigin(endpoint);
  if (origin) guardianOrigins.add(origin);
}

/**
 * Route a guardian endpoint's origin for the rest of the session. For an
 * endpoint the account is bound to, or one just verified as a Guardian; an
 * endpoint that is still being checked takes `probeGuardianOrigin` instead.
 * The built-in GUARDIAN_OPTIONS are pre-seeded. Installs the boundary first.
 */
export function registerGuardianOrigin(endpoint: string): void {
  installGuardianFetchBoundary();
  addOrigin(endpoint);
}

/**
 * Route `endpoint`'s origin while it is probed, for a caller that cannot yet
 * tell whether a Guardian answers there. Settle with `true` once one does,
 * which keeps the origin routed as `registerGuardianOrigin` would, or `false`,
 * which releases this probe's hold. The first settle decides; later ones do
 * nothing. A probe never removes an origin registered for the session, and an
 * unparseable endpoint gets a settle that does nothing. Installs the boundary
 * first. Never throws.
 */
export function probeGuardianOrigin(endpoint: string): (isGuardian: boolean) => void {
  installGuardianFetchBoundary();
  const origin = parseOrigin(endpoint);
  if (!origin) return () => undefined;
  const hold = Symbol(origin);
  const holds = probeHolds.get(origin) ?? new Set<symbol>();
  holds.add(hold);
  probeHolds.set(origin, holds);
  return isGuardian => {
    if (!holds.delete(hold)) return;
    if (isGuardian) guardianOrigins.add(origin);
    if (holds.size === 0) probeHolds.delete(origin);
  };
}

/**
 * Run `check` under a probe of `endpoint` (`probeGuardianOrigin`) and return its
 * result. The probe settles with the verdict `isGuardian(result)` once `check`
 * resolves, so the origin stays routed only for a result that shows a Guardian,
 * and with `false` when `check` rejects, with the rejection passed on.
 */
export async function withGuardianProbe<T>(
  endpoint: string,
  check: () => Promise<T>,
  isGuardian: (result: T) => boolean = () => true
): Promise<T> {
  const settle = probeGuardianOrigin(endpoint);
  try {
    const result = await check();
    settle(isGuardian(result));
    return result;
  } finally {
    // A no-op after the verdict above: only the first settle counts.
    settle(false);
  }
}

function isRoutedOrigin(origin: string): boolean {
  if (!guardianOrigins.has(origin) && !probeHolds.has(origin)) return false;
  // Read per request, never at import (see seedBuiltinGuardianOrigins), so an endpoint override applies at once.
  const appOwned = [
    globalThis.location.origin,
    getEffectiveRpcUrl(),
    getEffectiveProverUrl(),
    getEffectiveNoteTransportUrl()
  ];
  return !appOwned.some(url => url !== undefined && parseOrigin(url) === origin);
}

let installed = false;

/**
 * Put the boundary in front of `globalThis.fetch`. Idempotent. Mobile installs it
 * at startup, before the backend; every platform also installs it from
 * `registerGuardianOrigin` and `probeGuardianOrigin`, so code that routes a
 * Guardian origin always has a bounded fetch. A realm with no fetch (jsdom) is
 * left alone until it has one.
 */
export function installGuardianFetchBoundary(): void {
  if (installed || typeof globalThis.fetch !== 'function') return;
  installed = true;

  seedBuiltinGuardianOrigins();

  const originalFetch: FetchFn = globalThis.fetch.bind(globalThis);
  const native = isMobile();

  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const origin = parseOrigin(url);
    if (!origin || !isRoutedOrigin(origin)) {
      return originalFetch(input, init);
    }
    return native ? guardianNativeFetch(url, input, init) : guardianWebFetch(originalFetch, url, input, init);
  };
}

interface GuardianDeadline {
  /** Aborts at the deadline, or with the caller's own abort, whichever comes first. */
  readonly signal: AbortSignal;
  /**
   * Run `start` unless the request is already cut off, and settle with it or with
   * the cut-off, whichever comes first. An answer that comes first is used
   * whenever it arrives, even past the deadline on a timer running late: the
   * deadline bounds the wait, and discarding an answer the Guardian already
   * delivered would orphan what it did, such as a proposal it created. A native
   * request cannot be cancelled, so an answer that arrives after the cut-off is
   * dropped. A failure that arrives once the deadline has passed is the cut-off
   * too, though the timer has not fired: timers run late or sleep through a
   * suspension while the request times out on its own.
   */
  race<T>(start: () => Promise<T>): Promise<T>;
  /** Stop the timer and the forwarded caller abort. */
  release(): void;
}

/** The caller's own signal, on both transports: `init`'s, or failing that a Request input's. */
function callerSignalOf(input: RequestInfo | URL, init?: RequestInit): AbortSignal | undefined {
  return init?.signal ?? (input instanceof Request ? input.signal : undefined);
}

function startGuardianDeadline(url: string, callerSignal: AbortSignal | undefined): GuardianDeadline {
  const startedAt = monotonicNowMs();
  const controller = new AbortController();
  // Kept beside the signal: engines older than abort reasons drop the argument to abort().
  let cutOffReason: unknown;
  const cutOff = (reason: unknown): void => {
    if (controller.signal.aborted) return;
    cutOffReason = reason;
    controller.abort(reason);
  };
  const onCallerAbort = (): void =>
    cutOff(callerSignal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
  const timer = setTimeout(
    () => cutOff(new GuardianRequestTimeoutError(url, GUARDIAN_REQUEST_TIMEOUT_MS)),
    GUARDIAN_REQUEST_TIMEOUT_MS
  );
  if (callerSignal?.aborted) {
    onCallerAbort();
  } else {
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  }
  return {
    signal: controller.signal,
    race: <T>(start: () => Promise<T>): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        if (controller.signal.aborted) {
          reject(cutOffReason);
          return;
        }
        controller.signal.addEventListener('abort', () => reject(cutOffReason), { once: true });
        start().then(resolve, (error: unknown) => {
          const pastDeadline = monotonicNowMs() - startedAt >= GUARDIAN_REQUEST_TIMEOUT_MS;
          reject(pastDeadline ? new GuardianRequestTimeoutError(url, GUARDIAN_REQUEST_TIMEOUT_MS) : error);
        });
      }),
    release: (): void => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  };
}

/**
 * Off mobile: the original fetch under the deadline. The body is read inside the
 * deadline too, because guardian-client reads it after `fetch` resolves, and a
 * deadline that ended at the headers would leave a stalled body unbounded.
 */
function guardianWebFetch(
  originalFetch: FetchFn,
  url: string,
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const deadline = startGuardianDeadline(url, callerSignalOf(input, init));
  return deadline
    .race(async () => {
      const response = await originalFetch(input, { ...init, signal: deadline.signal });
      const body = await response.arrayBuffer();
      return new Response(NULL_BODY_STATUSES.has(response.status) ? null : body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    })
    .finally(deadline.release);
}

async function guardianNativeFetch(url: string, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : null;
  const method = init?.method ?? request?.method ?? 'GET';
  const headers = normalizeHeaders(init?.headers ?? request?.headers);

  // guardian-client always sends JSON string bodies; CapacitorHttp serializes
  // `data` itself for JSON content types, so hand it the parsed value to avoid
  // double-encoding.
  const rawBody = typeof init?.body === 'string' ? init.body : undefined;
  const contentType = Object.entries(headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? '';
  const data = rawBody !== undefined && contentType.includes('application/json') ? JSON.parse(rawBody) : rawBody;

  const deadline = startGuardianDeadline(url, callerSignalOf(input, init));
  // The native timeouts bound the native request; what the caller sees is the JS deadline, which reads a failure past
  // it as the cut-off.
  const nativeResponse = await deadline
    .race(() =>
      CapacitorHttp.request({
        url,
        method,
        headers,
        data,
        responseType: 'text',
        connectTimeout: GUARDIAN_REQUEST_TIMEOUT_MS,
        readTimeout: GUARDIAN_REQUEST_TIMEOUT_MS
      })
    )
    .finally(deadline.release);

  const responseData: unknown = nativeResponse.data;
  const bodyText =
    typeof responseData === 'string' ? responseData : responseData == null ? '' : JSON.stringify(responseData);

  return new Response(NULL_BODY_STATUSES.has(nativeResponse.status) ? null : bodyText, {
    status: nativeResponse.status,
    headers: nativeResponse.headers
  });
}

function normalizeHeaders(headers?: HeadersInit): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key] = value;
    });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      if (key && value !== undefined) result[key] = value;
    }
  } else {
    Object.assign(result, headers);
  }
  return result;
}
