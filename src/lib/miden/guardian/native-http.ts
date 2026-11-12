import { CapacitorHttp, registerPlugin } from '@capacitor/core';

import { monotonicNowMs } from 'lib/miden/sync-backoff';
import {
  getEffectiveNoteTransportUrl,
  getEffectiveProverUrl,
  getEffectiveRpcUrl
} from 'lib/miden-chain/effective-endpoints';
import { getKnownGuardians, subscribeGuardians } from 'lib/miden-chain/guardian-registry';
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
 * A Guardian request the boundary cut off at its deadline. Two readers
 * recognize it by `name` anywhere in a cause chain (`isGuardianRequestTimeout`
 * in ./serialize): `isGuardianOutage`, which the transaction loop's unreachable
 * arm and its failure copy read, and guardian-sync. Its message says
 * "timed out", so the other Guardian error checks read it as an unreachable
 * Guardian.
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
type GuardianProbeRequestBudget = { timeoutMs: number; startedAt: number };
const guardianProbeRequestBudgets = new WeakMap<AbortSignal, GuardianProbeRequestBudget>();
const guardianNativeProbeSettlements = new WeakMap<AbortSignal, Promise<void>>();

/** Keep a native Guardian probe read bounded by the deadline that owns its permit. */
export function registerGuardianProbeRequestBudget(signal: AbortSignal, timeoutMs: number): () => void {
  const budget: GuardianProbeRequestBudget = {
    timeoutMs: Number.isFinite(timeoutMs) ? Math.max(1, Math.ceil(timeoutMs)) : GUARDIAN_REQUEST_TIMEOUT_MS,
    startedAt: monotonicNowMs()
  };
  guardianProbeRequestBudgets.set(signal, budget);
  return () => {
    if (guardianProbeRequestBudgets.get(signal) === budget) guardianProbeRequestBudgets.delete(signal);
  };
}

/**
 * The native probe read started for this attempt signal. An attempt that never started one is already
 * settled, so the permit wait does not hang. The entry stays after the read settles: both handlers
 * swallow, and a late native settlement cannot escape as an unhandled rejection.
 */
export function guardianNativeProbeSettlement(signal: AbortSignal): Promise<void> {
  return guardianNativeProbeSettlements.get(signal) ?? Promise.resolve();
}

// Routed for the session: the built-ins, and endpoints bound to an account or proved to be a Guardian.
const guardianOrigins = new Set<string>();
// Routed only while probed: each origin's in-flight probes.
const probeHolds = new Map<string, Set<symbol>>();
// Response() rejects a non-null body for these statuses.
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * Seed the origins of every operator the wallet's configuration names, on any
 * network: each network's config-document list, else its bundled one
 * (`getKnownGuardians`). Runs at the first interceptor install and again each
 * time a document changes a list, so an operator a document adds is routed
 * without a restart. An origin a document removes stays routed for the
 * session, like every other registered origin. Deferred from module load: this
 * module must not read the lists while its importers are still loading.
 */
function seedBuiltinGuardianOrigins(): void {
  for (const option of getKnownGuardians()) addOrigin(option.endpoint);
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
 * The operators the wallet's configuration names are pre-seeded. Installs the boundary first.
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
  subscribeGuardians(seedBuiltinGuardianOrigins);

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

interface GuardianProbeHttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  data?: string;
  requestId: string;
  timeoutMs: number;
}

interface GuardianProbeHttpResponse {
  data?: unknown;
  status: number;
  headers?: Record<string, string>;
  url?: string;
}

interface GuardianProbeHttpPlugin {
  request(options: GuardianProbeHttpRequest): Promise<GuardianProbeHttpResponse>;
  cancel(options: { requestId: string }): Promise<void>;
}

interface GuardianNativeResponse {
  data?: unknown;
  status: number;
  headers?: HeadersInit;
}

/** The plugin handle is created on the first probe read, never at module load. */
let guardianProbeHttpPlugin: GuardianProbeHttpPlugin | undefined;

function guardianProbeHttp(): GuardianProbeHttpPlugin {
  guardianProbeHttpPlugin ??= registerPlugin<GuardianProbeHttpPlugin>('GuardianProbeHttp');
  return guardianProbeHttpPlugin;
}

function callerAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * A rejected cancel must not replace the plugin request recorded as this signal's settlement.
 * The permit waits on that request, including while cancel is in flight.
 */
function cancelGuardianProbeRead(plugin: GuardianProbeHttpPlugin, requestId: string): void {
  try {
    void Promise.resolve(plugin.cancel({ requestId })).then(
      () => undefined,
      () => undefined
    );
  } catch {
    // The native read already stored for this signal is unchanged.
  }
}

function guardianResponseFromNative(nativeResponse: GuardianNativeResponse): Response {
  const responseData: unknown = nativeResponse.data;
  const bodyText =
    typeof responseData === 'string' ? responseData : responseData == null ? '' : JSON.stringify(responseData);

  return new Response(NULL_BODY_STATUSES.has(nativeResponse.status) ? null : bodyText, {
    status: nativeResponse.status,
    headers: nativeResponse.headers
  });
}

/**
 * A probe read ends when its attempt budget ends. CapacitorHttp's read timeout resets while bytes
 * arrive and its promise cannot be cancelled, so a trickle would keep the permit the read holds.
 * `timeoutMs` is the remaining budget, at least 1 ms, and the plugin's lifetime is that long from
 * the start of the call. The caller-facing fetch rejects at the ceiling or on abort; the settlement
 * promise is the plugin request, so the permit stays out until that call settles.
 */
function readGuardianProbeNative(
  url: string,
  method: string,
  headers: Record<string, string>,
  rawBody: string | undefined,
  callerSignal: AbortSignal,
  probeBudget: GuardianProbeRequestBudget
): Promise<GuardianNativeResponse> {
  if (callerSignal.aborted) throw callerAbortReason(callerSignal);
  const deadlineAt = probeBudget.startedAt + probeBudget.timeoutMs;
  const remainingMs = deadlineAt - monotonicNowMs();
  if (remainingMs <= 0) throw new GuardianRequestTimeoutError(url, probeBudget.timeoutMs);

  const timeoutMs = Math.max(1, Math.ceil(remainingMs));
  const requestId = crypto.randomUUID();
  const plugin = guardianProbeHttp();
  const nativeRequest = plugin.request({
    url,
    method,
    headers,
    ...(rawBody !== undefined ? { data: rawBody } : {}),
    requestId,
    timeoutMs
  });
  // Recorded before this function returns, which is before the patched fetch awaits the response.
  guardianNativeProbeSettlements.set(
    callerSignal,
    nativeRequest.then(
      () => undefined,
      () => undefined
    )
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopWaiting = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      callerSignal.removeEventListener('abort', onAbort);
    };
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      stopWaiting();
      settle();
    };
    const cutOff = (): void => {
      finish(() => {
        cancelGuardianProbeRead(plugin, requestId);
        reject(
          callerSignal.aborted ? callerAbortReason(callerSignal) : new GuardianRequestTimeoutError(url, timeoutMs)
        );
      });
    };
    const onAbort = (): void => cutOff();
    timer = setTimeout(cutOff, timeoutMs);
    if (callerSignal.aborted) {
      cutOff();
      return;
    }
    callerSignal.addEventListener('abort', onAbort, { once: true });
    nativeRequest.then(
      response => {
        finish(() => {
          if (callerSignal.aborted) {
            reject(callerAbortReason(callerSignal));
            return;
          }
          if (monotonicNowMs() >= deadlineAt) {
            reject(new GuardianRequestTimeoutError(url, timeoutMs));
            return;
          }
          resolve(response);
        });
      },
      (error: unknown) => {
        finish(() => {
          if (callerSignal.aborted) {
            reject(callerAbortReason(callerSignal));
            return;
          }
          if (monotonicNowMs() >= deadlineAt) {
            reject(new GuardianRequestTimeoutError(url, timeoutMs));
            return;
          }
          reject(error);
        });
      }
    );
  });
}

async function guardianNativeFetch(url: string, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : null;
  const method = init?.method ?? request?.method ?? 'GET';
  const headers = normalizeHeaders(init?.headers ?? request?.headers);

  // guardian-client always sends JSON string bodies; CapacitorHttp serializes
  // `data` itself for JSON content types, so hand it the parsed value to avoid
  // double-encoding. A probe read sends the string body unchanged.
  const rawBody = typeof init?.body === 'string' ? init.body : undefined;
  const contentType = Object.entries(headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? '';
  const data = rawBody !== undefined && contentType.includes('application/json') ? JSON.parse(rawBody) : rawBody;

  const callerSignal = callerSignalOf(input, init);
  const probeBudget = callerSignal ? guardianProbeRequestBudgets.get(callerSignal) : undefined;
  if (callerSignal !== undefined && probeBudget !== undefined) {
    return guardianResponseFromNative(
      await readGuardianProbeNative(url, method, headers, rawBody, callerSignal, probeBudget)
    );
  }

  // The native timeouts bound the native request; what the caller sees is the JS deadline, which reads a
  // failure past it as the cut-off.
  const deadline = startGuardianDeadline(url, callerSignal);
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
  return guardianResponseFromNative(nativeResponse);
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
