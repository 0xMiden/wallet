import { CapacitorHttp } from '@capacitor/core';

import { GUARDIAN_OPTIONS } from 'lib/miden-chain/constants';
import {
  getEffectiveNoteTransportUrl,
  getEffectiveProverUrl,
  getEffectiveRpcUrl
} from 'lib/miden-chain/effective-endpoints';
import { isMobile } from 'lib/platform';

/**
 * CORS bypass for guardian HTTP on mobile.
 *
 * Guardian operators don't (yet) emit `Access-Control-Allow-Origin` for the
 * Capacitor WebView origin, so plain `fetch` to a guardian endpoint fails the
 * access-control check on iOS/Android. `@openzeppelin/guardian-client`
 * hardcodes global `fetch` with no injectable transport, so the only seam we
 * control is `globalThis.fetch` itself: requests whose origin matches a known
 * guardian endpoint are routed through `CapacitorHttp.request()` (native HTTP,
 * not subject to CORS); everything else passes through untouched. Scoping by
 * origin avoids Capacitor's global fetch-patching mode, which is known to
 * break binary responses (the SDK's gRPC-web/WASM fetches).
 *
 * So an origin the app itself fetches from (the page, the node RPC, the prover,
 * the note transport) is never routed, whoever registered it, judged per request.
 * And an endpoint not yet known to be a Guardian is routed only while a probe of
 * it is in flight (`probeGuardianOrigin`), so a URL that turns out not to be one
 * is not left routed for the session.
 *
 * The guardian API is JSON-only, so reconstructing a `Response` from the
 * native result is lossless. Extension/desktop are unaffected (`isMobile()`
 * no-ops the install); the extension bypasses CORS via host permissions.
 */

// Routed for the session: the built-ins, and endpoints bound to an account or proved to be a Guardian.
const guardianOrigins = new Set<string>();
// Routed only while probed: each origin's in-flight probes.
const probeHolds = new Map<string, Set<symbol>>();

/**
 * Seed the built-in guardian origins. Deferred from module-load to first
 * interceptor install: importing this module must not iterate GUARDIAN_OPTIONS
 * eagerly, or a `lib/miden-chain/constants` <-> native-http import cycle can
 * observe `GUARDIAN_OPTIONS` before it's initialized (undefined → throw at
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
 * The built-in GUARDIAN_OPTIONS are pre-seeded.
 */
export function registerGuardianOrigin(endpoint: string): void {
  addOrigin(endpoint);
}

/**
 * Route `endpoint`'s origin while it is probed, for a caller that cannot yet
 * tell whether a Guardian answers there. Settle with `true` once one does,
 * which keeps the origin routed as `registerGuardianOrigin` would, or `false`,
 * which releases this probe's hold. The first settle decides; later ones do
 * nothing. A probe never removes an origin registered for the session, and an
 * unparseable endpoint gets a settle that does nothing. Never throws.
 */
export function probeGuardianOrigin(endpoint: string): (isGuardian: boolean) => void {
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

export function installGuardianCorsBypass(): void {
  if (installed || !isMobile()) return;
  installed = true;

  seedBuiltinGuardianOrigins();

  const originalFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const origin = parseOrigin(url);
    if (!origin || !isRoutedOrigin(origin)) {
      return originalFetch(input, init);
    }
    return guardianNativeFetch(url, input, init);
  };
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

  const nativeResponse = await CapacitorHttp.request({
    url,
    method,
    headers,
    data,
    responseType: 'text'
  });

  const responseData: unknown = nativeResponse.data;
  const bodyText =
    typeof responseData === 'string' ? responseData : responseData == null ? '' : JSON.stringify(responseData);
  // Response() rejects a non-null body for these statuses.
  const bodyAllowed = ![204, 205, 304].includes(nativeResponse.status);

  return new Response(bodyAllowed ? bodyText : null, {
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
