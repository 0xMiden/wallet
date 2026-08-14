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
 * FIDELITY BOUNDARY (verified live — read before writing a fault spec). The seam
 * intercepts `globalThis.fetch`, so it reaches the SDK's FETCH-based traffic: the
 * node READ/sync RPCs (SyncState / GetAccount / GetBlockHeader → note discovery,
 * balances, chain head) and note-transport reads. It does NOT reach the delegated
 * PROVER or the transaction SUBMIT: those go over a transport the evaluate-
 * installed wrapper can't retrofit (confirmed — a prover fault leaves the tx-
 * prover container still proving, and a consume SUBMITTED under a node fault still
 * lands on-chain). So a `node` fault here models a "reads/discovery unavailable"
 * outage, NOT a total partition, and `prover` faults are effectively inert.
 * Design specs around DISCOVERY / staleness / read-path resilience (which this
 * reliably faults); to fault submit/prove or simulate a total node partition, use
 * infra-level faulting (e.g. `docker pause`) instead.
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
            g.__E2E_NET_FAULT_HITS = {};
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
  /** Clear faults in every realm. */
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

  return {
    arm: (wire: FetchFaultWire[]) => applyAll(wire),
    clear: () => applyAll([])
  };
}
