import type { Page, Worker } from '@playwright/test';

import type { FetchFaultWire, NetworkFaultPolicy, NetworkFaultTarget, NetworkOrigins } from './network-faults';

/**
 * Fetch-layer fault injection for the gRPC-web targets (node RPC / remote
 * prover / note-transport).
 *
 * WHY this exists separately from the `context.route` seam (network-faults.ts):
 * the node/prover/transport traffic is gRPC-web issued by the Miden SDK's
 * compiled-Rust client, which runs in the extension's SERVICE WORKER and/or the
 * SDK's dedicated page-worker (`web-client-methods-worker.js`) — NOT as a
 * routable page request. Playwright's `context.route` never sees it (verified:
 * arming a node fault via context.route was a silent no-op). So those faults are
 * applied at the `fetch` layer INSIDE each realm, by the wrapper installed via
 * `attachServiceWorkerFetchCapture` (network-capture.ts), which reads the armed
 * config from `globalThis.__E2E_NET_FAULTS`.
 *
 * This module owns the Node-side controls: it converts NetworkFaultPolicy →
 * FetchFaultWire, pushes the config into every relevant realm (the SW + all
 * current page-workers), and re-applies it to any worker the page spawns later
 * (the SDK spawns its worker lazily on first use, often AFTER a fault is armed).
 *
 * FIDELITY BOUNDARY (verified live, the hard way — read before writing a fault
 * spec). The seam intercepts `globalThis.fetch` in the SW + SDK worker. Only ONE
 * class of SDK traffic actually goes through that `fetch`:
 *
 *   ✅ node READ / sync RPCs — SyncState / GetAccount / GetBlockHeader (→ note
 *      discovery, balances, chain head). VERIFIED biting: these log
 *      `INJECTED:<mode>` and a note minted while offline is undiscoverable.
 *
 * Everything else was verified NOT to reach this `fetch` and is therefore
 * effectively INERT as a fault target here:
 *   ❌ delegated PROVER  — a prover fault leaves the tx-prover container still
 *                          producing the proof.
 *   ❌ transaction SUBMIT — a consume/send SUBMITTED under a node fault still
 *                          lands on-chain (funds are genuinely spendable).
 *   ❌ note-transport delivery reads — a private note is still delivered to a
 *                          recipient whose transport is faulted (ZERO transport
 *                          requests are seen at this fetch layer).
 *
 * These three use a non-`fetch` transport (a gRPC-web streaming client in the
 * compiled SDK) the evaluate-installed wrapper cannot retrofit. So a `node`
 * fault models a "reads/discovery unavailable" outage — NOT a total partition —
 * and `prover`/`transport` faults do nothing. Write fetch-seam specs ONLY around
 * node read/discovery/staleness resilience. To fault prover / submit / transport
 * delivery, or to simulate a total node partition, use INFRA-level faulting
 * (`docker pause <svc>` / disconnect the container network) instead. (Guardian
 * HTTP is a separate, working seam — `context.route` in network-faults.ts.)
 */

/** Targets whose traffic is gRPC-web-in-realm and must be faulted at the fetch layer. */
export const FETCH_FAULT_TARGETS: readonly NetworkFaultTarget[] = ['node', 'prover', 'transport'];

export const isFetchFaultTarget = (t: NetworkFaultTarget): boolean => FETCH_FAULT_TARGETS.includes(t);

// The only page-worker that issues gRPC-web. The other workers are the rayon
// WASM thread-pool (parked in atomics.wait → `evaluate` hangs); never touch them.
const NETWORK_WORKER_RE = /web-client-methods-worker/;

const portSubstringOf = (origin: string): string => {
  try {
    const { port } = new URL(origin);
    return port ? `:${port}` : origin;
  } catch {
    return origin;
  }
};

/** Convert the fetch-target subset of a policy list into the serialized wire form. */
export function toFetchWire(policies: NetworkFaultPolicy[], origins: NetworkOrigins): FetchFaultWire[] {
  return policies
    .filter(p => isFetchFaultTarget(p.target))
    .map((p, i) => ({
      id: `f${i}:${p.target}:${p.path ?? ''}:${p.mode}`,
      host: portSubstringOf(origins[p.target]),
      path: p.path,
      mode: p.mode,
      count: p.count,
      delayMs: p.delayMs,
      retryAfterSec: p.retryAfterSec
    }));
}

async function applyToRealm(realm: Worker, wire: FetchFaultWire[]): Promise<void> {
  // `realm.evaluate` runs on the realm's JS thread, which the single-threaded
  // WASM client can hold for seconds (a sync/prove in flight). Never let that
  // hang arming: bound each attempt and retry a few times so the config lands as
  // soon as the WASM yields (it yields between fetches), while a realm that's
  // torn down or busy for the whole test just drops out (best effort).
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await Promise.race([
        realm
          .evaluate(cfg => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const g = globalThis as any;
            g.__E2E_NET_FAULTS = cfg;
            // PRESERVED across a re-arm, zeroed only by `clear()`. The wrapper
            // captures this object and increments it before it hangs, so
            // replacing it here orphaned exactly the hits a `hang` spec needs:
            // those specs re-arm defensively (MV3 can restart the SW and lose the
            // config) and, by the very coalescing they are testing, no NEW fetch
            // follows the re-arm — so `hits()` read a fresh empty map and the
            // "did the fault actually land" check failed for the case it exists
            // to prove. Cumulative-per-arm was never what any caller wanted.
            g.__E2E_NET_FAULT_HITS = g.__E2E_NET_FAULT_HITS || {};
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return { wrapped: !!(globalThis as any).__e2e_fetch_wrapped, url: (globalThis as any).location?.href };
          }, wire)
          .then(r => {
            if (process.env.FETCH_FAULT_DEBUG) {
              // eslint-disable-next-line no-console
              console.log(`[fetch-fault-debug] armed realm wrapped=${JSON.stringify(r)}`);
            }
          }),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('evaluate timeout')), 3_000))
      ]);
      return;
    } catch (e) {
      if (process.env.FETCH_FAULT_DEBUG) {
        // eslint-disable-next-line no-console
        console.log(`[fetch-fault-debug] realm arm attempt ${attempt} failed: ${String(e).slice(0, 60)}`);
      }
      // busy or gone — retry (bounded)
    }
  }
}

export interface FetchFaultControls {
  /** Push a wire config to the SW + every current and future page-worker. */
  arm(wire: FetchFaultWire[]): Promise<void>;
  /**
   * Total injections recorded across every armed realm since `arm`, read from
   * the in-realm `__E2E_NET_FAULT_HITS` counter the fetch wrapper maintains.
   *
   * The point is falsifiability, and it matters most for `hang`. Arming is
   * BEST EFFORT by design (`applyToRealm` gives up after four bounded attempts
   * so a busy or torn-down realm cannot hang the suite), and the SDK spawns its
   * network worker lazily — so "the fault never landed" is a real outcome, not a
   * hypothetical. A spec that arms a hang and then asserts something did NOT
   * happen passes identically in that case, which makes its strongest-looking
   * assertion the one most able to go green for the wrong reason. Asserting a
   * non-zero count first turns that into a failure.
   *
   * Best effort in the same way arming is: a realm that cannot be evaluated
   * contributes 0 rather than throwing.
   */
  hits(): Promise<number>;
  /** Clear faults in every realm, and zero the hit counters. */
  clear(): Promise<void>;
}

/**
 * Install the Node-side fetch-fault controls. `getServiceWorker` is a thunk
 * because the fixture reassigns the SW handle across a crash-relaunch.
 */
export function installFetchFaultControls(getServiceWorker: () => Worker | undefined, page: Page): FetchFaultControls {
  let current: FetchFaultWire[] = [];

  // The SDK spawns its web-client worker lazily — often after a fault is armed.
  // Re-apply the current config to any worker that appears.
  page.on('worker', worker => {
    if (current.length && NETWORK_WORKER_RE.test(worker.url())) void applyToRealm(worker, current);
  });

  const applyAll = async (wire: FetchFaultWire[]): Promise<void> => {
    current = wire;
    // Only the SDK client worker (web-client-methods-worker) and the SW issue
    // gRPC-web; the other page-workers are the rayon WASM thread-pool, which park
    // in atomics.wait (JS thread blocked) so `evaluate` on them hangs forever.
    // Arming those is both futile (no network there) and a hang risk, so target
    // only the network realms.
    const realms: Worker[] = page.workers().filter(w => NETWORK_WORKER_RE.test(w.url()));
    const sw = getServiceWorker();
    if (sw) realms.push(sw);
    if (process.env.FETCH_FAULT_DEBUG) {
      // eslint-disable-next-line no-console
      console.log(
        `[fetch-fault-debug] applyAll: ${realms.length} network realm(s) (of ${page.workers().length} workers + sw=${!!sw}), wire=${JSON.stringify(wire)}`
      );
    }
    await Promise.all(realms.map(r => applyToRealm(r, wire)));
  };

  const readHits = async (): Promise<number> => {
    const realms: Worker[] = page.workers().filter(w => NETWORK_WORKER_RE.test(w.url()));
    const sw = getServiceWorker();
    if (sw) realms.push(sw);
    const perRealm = await Promise.all(
      realms.map(async realm => {
        try {
          return await Promise.race([
            realm.evaluate(() => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const hits = (globalThis as any).__E2E_NET_FAULT_HITS as Record<string, number> | undefined;
              return Object.values(hits ?? {}).reduce((total: number, n: number) => total + n, 0);
            }),
            new Promise<number>((_, reject) => setTimeout(() => reject(new Error('evaluate timeout')), 3_000))
          ]);
        } catch {
          return 0;
        }
      })
    );
    return perRealm.reduce((total, n) => total + n, 0);
  };

  const clearAll = async (): Promise<void> => {
    await applyAll([]);
    // Zero the hit map here, since `arm` deliberately preserves it. Best effort
    // in the same way arming is: a realm that cannot be evaluated keeps its
    // count, which at worst makes a later `hits()` assertion pass on stale
    // evidence — so a spec that cares should read `hits()` for a delta, or clear
    // before it arms.
    const realms: Worker[] = page.workers().filter(w => NETWORK_WORKER_RE.test(w.url()));
    const sw = getServiceWorker();
    if (sw) realms.push(sw);
    await Promise.all(
      realms.map(async realm => {
        try {
          await Promise.race([
            realm.evaluate(() => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (globalThis as any).__E2E_NET_FAULT_HITS = {};
            }),
            new Promise<void>((_, reject) => setTimeout(() => reject(new Error('evaluate timeout')), 3_000))
          ]);
        } catch {
          // busy or gone — leave the stale count rather than hang the suite
        }
      })
    );
  };

  return {
    arm: (wire: FetchFaultWire[]) => applyAll(wire),
    hits: readHits,
    clear: clearAll
  };
}
