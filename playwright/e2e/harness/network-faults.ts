import type { BrowserContext, Route } from '@playwright/test';

import {
  applyGuardianFaultAction,
  decideGuardianFault,
  type GuardianFaultPolicy,
  type GuardianOrigins
} from './guardian-fault';

/**
 * Whole-infra fault-injection layer for the resilience E2E suite.
 *
 * Generalizes the guardian-only `guardian-fault.ts` seam to EVERY external
 * dependency the wallet talks to (node RPC, remote prover, note-transport,
 * epoch positions/allocator, Anvil, AggLayer indexer, Binance, faucet, and the
 * guardians), so a resilience spec can arm `walletA.armNetworkFault({...})` and
 * assert the wallet degrades / recovers gracefully under that infra failing.
 *
 * ONE combined catch-all `context.route` handler is installed (see
 * `installNetworkFaults`). It tries the armed NETWORK policies first; on no
 * network match it DEFERS to the existing guardian decision path
 * (`decideGuardianFault`/`applyGuardianFaultAction`, imported unchanged) so the
 * guardian lifecycle suite keeps its exact behavior. A single handler is
 * required: two catch-all handlers that both `route.continue()` on non-match
 * throw Playwright's "Route is already handled!".
 *
 * MUST be installed on a context that allows service workers (the two-wallets
 * fixture default): node/prover/transport/guardian traffic is issued from the
 * extension's service worker (and the SDK's page-spawned worker), so
 * `context.route` only reaches them when SW network traffic isn't blocked.
 */

/** Every infra dependency a fault can target, keyed by its localnet origin. */
export type NetworkFaultTarget =
  | 'node' // Miden node gRPC-web (sync / submit / one-shot reads)
  | 'prover' // remote/delegated prover
  | 'transport' // note-transport-service (NTL relay)
  | 'guardianA' // guardian operator A
  | 'guardianB' // guardian operator B
  | 'positions' // epoch positions service
  | 'allocator' // epoch allocator service
  | 'anvil' // local EVM JSON-RPC
  | 'agglayer' // AggLayer bridge indexer (env-repointed host)
  | 'binance' // Binance price API (env-repointed host)
  | 'faucetMiden' // official Miden faucet REST
  | 'faucetForkchoice'; // forkchoice faucet HTTP

/**
 * Maps each target to the origin its requests come from. On the localhost stack
 * these are the container/service host ports (matching
 * `playwright/e2e/config/environments.ts` 'localhost'); the two env-repointed
 * hosts (agglayer, binance) default to placeholders overridden per-run by the
 * env-override seam (see `src/lib/agglayer/constant.ts` /
 * `src/lib/prices/binance.ts`) so their traffic hits localhost and is
 * interceptable. `guardianA`/`guardianB` mirror `LOCAL_GUARDIAN_ORIGINS`.
 */
export type NetworkOrigins = Record<NetworkFaultTarget, string>;

export const LOCAL_NETWORK_ORIGINS: NetworkOrigins = {
  node: 'http://localhost:57291',
  prover: 'http://localhost:50052',
  transport: 'http://localhost:57292',
  guardianA: 'http://localhost:3000',
  guardianB: 'http://localhost:3001',
  positions: 'http://localhost:8549',
  allocator: 'http://localhost:8548',
  anvil: 'http://localhost:8545',
  agglayer: 'http://localhost:8550',
  binance: 'http://localhost:8551',
  faucetMiden: 'http://localhost:8552',
  faucetForkchoice: 'http://localhost:8553'
};

/**
 * A single injected failure mode.
 *
 *   - `status500`            fulfill a generic 500.
 *   - `status429RetryAfter`  fulfill a 429 with a `Retry-After` header (default
 *                            1s, override via `retryAfterSec`) + a retryable body.
 *   - `abort`                abort the request (generic `'failed'` net error).
 *   - `connectionRefused`    abort with `'connectionrefused'` (server down / RST).
 *   - `timeout`              abort with `'timedout'`.
 *   - `hang`                 never settle the route — models an accept-then-
 *                            blackhole node (the request stays pending forever).
 *   - `delay`                wait `delayMs` (default 3000) then continue.
 *   - `slowStream`           wait `delayMs` (default 8000) then continue — a
 *                            slow-but-eventually-successful response.
 *   - `truncatedBody`        fulfill 200 with a truncated/partial body (`'{'`).
 *   - `malformedBody`        fulfill 200 with a non-JSON body.
 *   - `failFirstN`           fulfill 500 for the first `count` matches, then
 *                            pass through (models a transient blip that recovers).
 */
export type NetworkFaultMode =
  | 'status500'
  | 'status429RetryAfter'
  | 'abort'
  | 'connectionRefused'
  | 'timeout'
  | 'hang'
  | 'delay'
  | 'slowStream'
  | 'truncatedBody'
  | 'malformedBody'
  | 'failFirstN';

export interface NetworkFaultPolicy {
  /** Which dependency to fault. */
  target: NetworkFaultTarget;
  /**
   * Optional URL-substring narrowing within the target's origin (e.g. 'submit',
   * 'SyncState', 'GetBlockHeader', '/pow'). Omit to match every request to the
   * target. Matched case-sensitively against the full request URL.
   */
  path?: string;
  mode: NetworkFaultMode;
  /** Requests to fault before passing through. Used by `failFirstN` (default 1). */
  count?: number;
  /** Delay (ms). Used by `delay` (default 3000) and `slowStream` (default 8000). */
  delayMs?: number;
  /** `Retry-After` seconds. Used by `status429RetryAfter` (default 1). */
  retryAfterSec?: number;
}

/**
 * Serialized fault policy handed to the in-realm fetch wrapper
 * (harness/network-capture.ts) for node/prover/transport gRPC-web faults —
 * see fetch-faults.ts. `host` is a URL substring (a `:port`) since the same
 * target can appear as localhost or 127.0.0.1 on the wire.
 */
export interface FetchFaultWire {
  id: string;
  host: string;
  path?: string;
  mode: NetworkFaultMode;
  count?: number;
  delayMs?: number;
  retryAfterSec?: number;
}

export interface NetworkFaultControls {
  /**
   * Arm one or more network fault policies, REPLACING any previously-armed set
   * and resetting hit counters. Pass an array to fault several dependencies at
   * once (e.g. node submit + prover for a forced terminal failure). First
   * matching policy (in array order) wins for a given request.
   */
  armNetwork(policyOrPolicies: NetworkFaultPolicy | NetworkFaultPolicy[]): void;
  /**
   * Arm a guardian fault via the UNCHANGED guardian decision path (byte-identical
   * to `installGuardianFaults`). Backs the wallet page object's `armGuardianFault`.
   */
  armGuardian(policy: GuardianFaultPolicy): void;
  /**
   * How many guardian requests the armed guardian policy has faulted since it
   * was armed. Lets a spec assert the fault ACTUALLY FIRED (a guardian op that
   * completed with zero hits proves the fault never reached it — a false green),
   * without reaching into the container. Reset by `armGuardian`/`clear`.
   */
  guardianFaultHits(): number;
  /**
   * How many requests the armed NETWORK policy set has faulted since it was
   * armed (summed across policies). The network-seam counterpart of
   * `guardianFaultHits` — an op that "survived" an outage with zero hits proves
   * the fault never reached it (a false green). Reset by `armNetwork`/`clear`.
   * Only counts route-seam targets; fetch-layer targets (node/prover/transport)
   * are counted in their own realms (see fetch-faults.ts).
   */
  networkFaultHits(): number;
  /** Disarm everything — all subsequent requests pass through untouched. */
  clear(): void;
}

/**
 * The Route surface this module touches. Deliberately narrower than Playwright's
 * real `Route` (which satisfies it structurally) so the decision + apply logic
 * is unit-testable with a plain fake — no BrowserContext/browser required.
 */
export interface NetworkRouteLike {
  request(): { url(): string };
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
  fulfill(response: { status: number; body: string; headers?: Record<string, string> }): Promise<void>;
}

export type NetworkFaultAction =
  | { kind: 'passthrough' } // no network policy matched — caller defers to guardian
  | { kind: 'continue' } // matched, but count exhausted — send to network
  | { kind: 'abort'; errorCode: string }
  | { kind: 'hang' }
  | { kind: 'delay'; delayMs: number }
  | { kind: 'fulfill'; status: number; body: string; headers?: Record<string, string> };

const TRUNCATED_BODY = '{';
const MALFORMED_BODY = 'not a valid response body';
const RETRYABLE_429_BODY = JSON.stringify({ error: 'rate_limited', retryable: true });

const matchesOrigin = (url: string, origin: string): boolean =>
  url.startsWith(origin.endsWith('/') ? origin : `${origin}/`) || url === origin;

/** Which target a request URL belongs to, matched by origin, or null. */
export function targetOfNetwork(url: string, origins: NetworkOrigins): NetworkFaultTarget | null {
  for (const target of Object.keys(origins) as NetworkFaultTarget[]) {
    if (matchesOrigin(url, origins[target])) return target;
  }
  return null;
}

/** Does `policy` match this request URL? (target origin + optional path substring) */
function policyMatches(url: string, policy: NetworkFaultPolicy, origins: NetworkOrigins): boolean {
  if (targetOfNetwork(url, origins) !== policy.target) return false;
  if (policy.path && !url.includes(policy.path)) return false;
  return true;
}

/** Translate a matched policy into the action to apply. */
function actionFor(policy: NetworkFaultPolicy): NetworkFaultAction {
  switch (policy.mode) {
    case 'abort':
      return { kind: 'abort', errorCode: 'failed' };
    case 'connectionRefused':
      return { kind: 'abort', errorCode: 'connectionrefused' };
    case 'timeout':
      return { kind: 'abort', errorCode: 'timedout' };
    case 'hang':
      return { kind: 'hang' };
    case 'delay':
      return { kind: 'delay', delayMs: policy.delayMs ?? 3000 };
    case 'slowStream':
      return { kind: 'delay', delayMs: policy.delayMs ?? 8000 };
    case 'truncatedBody':
      return { kind: 'fulfill', status: 200, body: TRUNCATED_BODY };
    case 'malformedBody':
      return { kind: 'fulfill', status: 200, body: MALFORMED_BODY };
    case 'status429RetryAfter':
      return {
        kind: 'fulfill',
        status: 429,
        body: RETRYABLE_429_BODY,
        headers: { 'retry-after': String(policy.retryAfterSec ?? 1) }
      };
    case 'status500':
    case 'failFirstN':
      return { kind: 'fulfill', status: 500, body: 'injected network fault' };
  }
}

/**
 * Pure fault decision for a single request against the armed network policy set.
 * Returns the first matching policy's action (and the updated per-policy hit
 * array), or `{ matchedIndex: -1, action: passthrough }` when no network policy
 * matches (the caller then defers to the guardian decision). `failFirstN`
 * self-clears: once a policy's hits reach its `count`, it stops matching (so the
 * blip "recovers"). Exported standalone (no Playwright dependency) for unit tests.
 */
export function decideNetworkFault(
  url: string,
  policies: NetworkFaultPolicy[],
  hits: number[],
  origins: NetworkOrigins
): { matchedIndex: number; action: NetworkFaultAction; hits: number[] } {
  const nextHits = hits.slice();
  for (let i = 0; i < policies.length; i++) {
    const policy = policies[i];
    if (!policy || !policyMatches(url, policy, origins)) continue;
    if (policy.mode === 'failFirstN' && (nextHits[i] ?? 0) >= (policy.count ?? 1)) {
      return { matchedIndex: i, action: { kind: 'continue' }, hits: nextHits };
    }
    nextHits[i] = (nextHits[i] ?? 0) + 1;
    return { matchedIndex: i, action: actionFor(policy), hits: nextHits };
  }
  return { matchedIndex: -1, action: { kind: 'passthrough' }, hits: nextHits };
}

/**
 * Apply a network fault action to a live route (or a unit-test fake). `hang`
 * deliberately returns a never-settling promise — Playwright keeps the request
 * pending, modeling an accept-then-blackhole. `passthrough` must never reach
 * here (the installer handles it by deferring to guardian).
 */
export async function applyNetworkFaultAction(route: NetworkRouteLike, action: NetworkFaultAction): Promise<void> {
  switch (action.kind) {
    case 'passthrough':
    case 'continue':
      return route.continue();
    case 'abort':
      return route.abort(action.errorCode);
    case 'hang':
      return new Promise<void>(() => {
        /* never resolves — the request blackholes */
      });
    case 'delay':
      await new Promise<void>(resolve => setTimeout(resolve, action.delayMs));
      return route.continue();
    case 'fulfill':
      return route.fulfill({ status: action.status, body: action.body, headers: action.headers });
  }
}

/**
 * Installs the single combined context-wide route handler. Tries the armed
 * network policies first; on `passthrough` (no network match) defers to the
 * guardian decision path (unchanged). `armNetwork`/`armGuardian` set independent
 * slots; `clear` disarms both.
 */
export function installNetworkFaults(
  context: BrowserContext,
  origins: { network: NetworkOrigins; guardian: GuardianOrigins }
): NetworkFaultControls {
  let networkPolicies: NetworkFaultPolicy[] = [];
  let networkHits: number[] = [];
  let guardianPolicy: GuardianFaultPolicy | null = null;
  let guardianHits = 0;

  context.route('**/*', async (route: Route) => {
    const url = route.request().url();

    const net = decideNetworkFault(url, networkPolicies, networkHits, origins.network);
    networkHits = net.hits;
    if (net.action.kind !== 'passthrough') {
      await applyNetworkFaultAction(route, net.action);
      return;
    }

    const guardian = decideGuardianFault(url, guardianPolicy, guardianHits, origins.guardian);
    guardianHits = guardian.hits;
    await applyGuardianFaultAction(route, guardian.action);
  });

  return {
    armNetwork(policyOrPolicies) {
      networkPolicies = Array.isArray(policyOrPolicies) ? policyOrPolicies : [policyOrPolicies];
      networkHits = networkPolicies.map(() => 0);
    },
    armGuardian(policy) {
      guardianPolicy = policy;
      guardianHits = 0;
    },
    guardianFaultHits() {
      return guardianHits;
    },
    networkFaultHits() {
      return networkHits.reduce((sum, n) => sum + n, 0);
    },
    clear() {
      networkPolicies = [];
      networkHits = [];
      guardianPolicy = null;
      guardianHits = 0;
    }
  };
}
