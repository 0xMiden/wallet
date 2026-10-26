import * as http from 'http';
import type { AddressInfo } from 'net';

/**
 * A local stand-in for Aptabase's ingestion endpoint.
 *
 * DELIBERATELY not real Aptabase. Self-hosting it needs Postgres AND
 * ClickHouse, and minting an app key needs an authenticated session (magic-link
 * email), off an image tagged `:main` rather than a version — several hundred MB
 * of stateful services, bootstrapped by scraping a token out of container logs,
 * sitting next to a suite that already runs a blockchain. What that buys over
 * this is one thing: proof that Aptabase ACCEPTS our envelope. What it costs is
 * a large new flake surface, which is the opposite of what this suite is for.
 *
 * So the split is explicit. This sink covers everything on OUR side of the
 * boundary, which is the half that changes and the half we can get wrong:
 * whether anything is sent before consent, what exactly is in the envelope, and
 * whether a real wallet's real secrets can reach it. The vendor contract is
 * covered by `assertAptabaseContract` below, transcribed from their published
 * API, and by the note in `docs/telemetry-limitations.md`. If they change the
 * contract under us, this suite stays green and events start being rejected in
 * production — a real gap, stated rather than papered over.
 */

/** Aptabase's single-event ingestion path. */
export const EVENT_PATH = '/api/v0/event';

export interface SinkRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  /** Verbatim, before any parsing — what the sentinel scan reads. */
  body: string;
}

export interface AptabaseSink {
  readonly port: number;
  /** Every request received, in arrival order, including malformed ones. */
  readonly requests: readonly SinkRequest[];
  /** Resolve once at least `count` requests have arrived, else reject. */
  waitForRequests(count: number, timeoutMs?: number): Promise<void>;
  /** Resolve after `ms` of no new requests. For asserting an absence. */
  settle(ms: number): Promise<void>;
  close(): Promise<void>;
}

export async function startAptabaseSink(port = 0): Promise<AptabaseSink> {
  const requests: SinkRequest[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8')
      });
      // Aptabase answers a single event with 200 and an empty body. Answer the
      // same for ANY path, so a wallet posting to the wrong one shows up as a
      // recorded request with an unexpected path rather than as a connection
      // error the wallet would swallow as best-effort and hide.
      //
      // CORS matters even though `host_permissions` includes `http://localhost/*`:
      // the wallet reaches production Aptabase purely on the vendor's permissive
      // CORS, so a sink that did not allow it would be more permissive than
      // production and could hide a preflight regression.
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      });
      res.end('{}');
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const boundPort = (server.address() as AddressInfo).port;

  return {
    port: boundPort,
    requests,
    async waitForRequests(count, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      while (requests.length < count) {
        if (Date.now() > deadline) {
          throw new Error(
            `Expected at least ${count} telemetry request(s) within ${timeoutMs}ms, got ${requests.length}.`
          );
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    },
    async settle(ms) {
      let seen = -1;
      // Quiet for a full window, not merely `ms` from now: an event that lands
      // late still resets the clock, so "nothing arrived" cannot be satisfied
      // by a request that was simply slower than one fixed wait.
      while (seen !== requests.length) {
        seen = requests.length;
        await new Promise(resolve => setTimeout(resolve, ms));
      }
    },
    async close() {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  };
}

/**
 * Everything the wallet must get right about Aptabase's request contract.
 *
 * Transcribed from the vendor's documented ingestion API, and from what their
 * own web SDK sends. Not verified against a running Aptabase — see the header.
 */
export function assertAptabaseContract(request: SinkRequest, expectedAppKey: string): void {
  const problems: string[] = [];

  if (request.method !== 'POST') problems.push(`method ${request.method}, expected POST`);
  if (request.path !== EVENT_PATH) problems.push(`path ${request.path}, expected ${EVENT_PATH}`);
  if (request.headers['app-key'] !== expectedAppKey) {
    problems.push(`App-Key header ${String(request.headers['app-key'])}, expected ${expectedAppKey}`);
  }
  if (!String(request.headers['content-type'] ?? '').includes('application/json')) {
    problems.push(`Content-Type ${String(request.headers['content-type'])}, expected application/json`);
  }
  // `credentials: 'omit'` is what stops a cookie riding along and turning a
  // stateless POST into something that identifies a browser across sessions.
  // Asserted here because it is invisible in the payload.
  if (request.headers.cookie !== undefined) problems.push(`sent a Cookie header: ${request.headers.cookie}`);

  if (problems.length > 0) {
    throw new Error(`Aptabase contract violated:\n  - ${problems.join('\n  - ')}\n  body: ${request.body}`);
  }
}
