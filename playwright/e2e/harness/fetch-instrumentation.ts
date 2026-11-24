import type { FetchFaultWire } from './network-faults';

export const SW_FETCH_LOG_PREFIX = '[E2E_NET] ';
export const OFFSCREEN_FETCH_FAULTS_KEY = '__miden_e2e_offscreen_fetch_faults';

/** Standalone source: Playwright evaluate and raw CDP serialize this function. */
export const installFetchInstrumentation = (prefix: string): void => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (g.__e2e_fetch_wrapped) return;
  g.__e2e_fetch_wrapped = true;

  const origFetch: typeof fetch = g.fetch.bind(g);
  // Mirrors network-capture's classification; serialized functions cannot import it.
  const HOST_PATTERN =
    /\/miden\.note_transport\.v1\.NoteTransportService\/|rpc\.(testnet|devnet)\.miden\.io|tx-prover\.(testnet|devnet)\.miden\.io|transport\.miden\.io|(localhost|127\.0\.0\.1):(57291|57292|5005[12])/;

  function classify(url: string): string {
    if (
      /\/miden\.note_transport\.v1\.NoteTransportService\/|transport\.miden\.io|(localhost|127\.0\.0\.1):57292/.test(
        url
      )
    )
      return 'transport';
    if (/rpc\.(testnet|devnet)\.miden\.io|(localhost|127\.0\.0\.1):57291/.test(url)) return 'rpc';
    if (/tx-prover\.(testnet|devnet)\.miden\.io|(localhost|127\.0\.0\.1):5005[12]/.test(url)) return 'prover';
    return 'other';
  }

  g.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method || (typeof input !== 'string' && !(input instanceof URL) ? input.method : 'GET');
    if (!HOST_PATTERN.test(url)) return origFetch(input, init);

    const category = classify(url);
    const faults = (g.__E2E_NET_FAULTS as FetchFaultWire[] | undefined) || [];
    if (faults.length) {
      g.__E2E_NET_FAULT_HITS = g.__E2E_NET_FAULT_HITS || {};
      const hits = g.__E2E_NET_FAULT_HITS as Record<string, number>;
      for (const f of faults) {
        if (!url.includes(f.host)) continue;
        if (f.path && !url.includes(f.path)) continue;
        const prior = hits[f.id] || 0;
        if (f.mode === 'failFirstN' && prior >= (f.count || 1)) break;
        hits[f.id] = prior + 1;
        console.log(prefix + JSON.stringify({ url, method, status: 0, category, err: 'INJECTED:' + f.mode }));
        if (f.mode === 'delay' || f.mode === 'slowStream') {
          await new Promise(r => setTimeout(r, f.delayMs || (f.mode === 'slowStream' ? 8000 : 3000)));
          break;
        }
        if (f.mode === 'hang') return new Promise<Response>(() => {});
        if (f.mode === 'status500' || f.mode === 'failFirstN') {
          return new Response('injected network fault', { status: 500 });
        }
        if (f.mode === 'status429RetryAfter') {
          return new Response(JSON.stringify({ error: 'rate_limited', retryable: true }), {
            status: 429,
            headers: { 'retry-after': String(f.retryAfterSec || 1) }
          });
        }
        if (f.mode === 'truncatedBody') return new Response('{', { status: 200 });
        if (f.mode === 'malformedBody') return new Response('not a valid response body', { status: 200 });
        throw new TypeError('Failed to fetch (injected ' + f.mode + ')');
      }
    }

    const realm = (g.location && g.location.href) || 'unknown';
    // Clone before fetch disturbs the request stream; read after fetch settles.
    let bodySource: unknown;
    try {
      if (
        category === 'transport' &&
        /\/miden\.note_transport\.v1\.NoteTransportService\/SendNoteWithProof$/.test(url)
      ) {
        const isRequest = typeof input !== 'string' && !(input instanceof URL);
        bodySource = init?.body ?? (isRequest ? input.clone() : undefined);
      }
    } catch {
      // capture is diagnostic; never let it disturb the fetch it wraps
    }

    const encodeBody = async (): Promise<string | undefined> => {
      try {
        if (!bodySource) return undefined;
        let bytes: Uint8Array | undefined;
        if (bodySource instanceof Uint8Array) bytes = bodySource;
        else if (bodySource instanceof ArrayBuffer) bytes = new Uint8Array(bodySource);
        else if (ArrayBuffer.isView(bodySource))
          bytes = new Uint8Array(bodySource.buffer, bodySource.byteOffset, bodySource.byteLength);
        else if (bodySource instanceof Request) {
          // A streaming body may never finish; capture must not wedge the request.
          const buffered = await Promise.race([
            bodySource.arrayBuffer(),
            new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 1000))
          ]);
          if (!buffered) return undefined;
          bytes = new Uint8Array(buffered);
        }
        if (!bytes || bytes.length === 0 || bytes.length > 8192) return undefined;
        let bin = '';
        for (const b of bytes) bin += String.fromCharCode(b);
        return btoa(bin);
      } catch {
        return undefined;
      }
    };

    const start = performance.now();
    try {
      if (category === 'transport' && String(method).toUpperCase() === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Allow-Methods': '*',
            'Access-Control-Expose-Headers': '*, grpc-status, grpc-message, grpc-status-details-bin'
          }
        });
      }
      const res = await origFetch(input, init);
      const durationMs = Math.round(performance.now() - start);
      const reqBody = await encodeBody();
      console.log(prefix + JSON.stringify({ url, method, status: res.status, durationMs, category, realm, reqBody }));
      if (category === 'transport') {
        // Expose gRPC trailers to WASM when NTS's CORS layer does not expose them.
        const headers = new Headers(res.headers);
        headers.set('Access-Control-Allow-Origin', '*');
        headers.set('Access-Control-Allow-Headers', '*');
        headers.set('Access-Control-Expose-Headers', '*, grpc-status, grpc-message, grpc-status-details-bin');
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
      }
      return res;
    } catch (err) {
      const durationMs = Math.round(performance.now() - start);
      const errStr = err instanceof Error ? err.message : String(err);
      const reqBody = await encodeBody();
      console.log(
        prefix + JSON.stringify({ url, method, status: 0, durationMs, category, err: errStr, realm, reqBody })
      );
      throw err;
    }
  };
};
