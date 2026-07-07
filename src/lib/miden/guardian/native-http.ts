import { CapacitorHttp } from '@capacitor/core';

import { GUARDIAN_OPTIONS } from 'lib/miden-chain/constants';
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
 * The guardian API is JSON-only, so reconstructing a `Response` from the
 * native result is lossless. Extension/desktop are unaffected (`isMobile()`
 * no-ops the install); the extension bypasses CORS via host permissions.
 */

const guardianOrigins = new Set<string>();

if (Array.isArray(GUARDIAN_OPTIONS)) {
  for (const option of GUARDIAN_OPTIONS) {
    addGuardianOptionOrigins(option);
  }
}

function addGuardianOptionOrigins(option: (typeof GUARDIAN_OPTIONS)[number]): void {
  for (const endpoint of option.endpoint.values()) {
    addOrigin(endpoint);
  }
}

function addOrigin(endpoint: string): void {
  try {
    guardianOrigins.add(new URL(endpoint).origin);
  } catch {
    // Not a parseable URL (e.g. half-typed custom endpoint) — nothing to match.
  }
}

/**
 * Track a guardian endpoint so the fetch interceptor recognizes it. Call this
 * wherever a guardian client is constructed — that's what makes custom
 * (self-hosted) endpoints work; the built-in GUARDIAN_OPTIONS are pre-seeded.
 */
export function registerGuardianOrigin(endpoint: string): void {
  addOrigin(endpoint);
}

let installed = false;

export function installGuardianCorsBypass(): void {
  if (installed || !isMobile()) return;
  installed = true;

  const originalFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    let origin: string | null = null;
    try {
      origin = new URL(url).origin;
    } catch {
      origin = null;
    }
    if (!origin || !guardianOrigins.has(origin)) {
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
