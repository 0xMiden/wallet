// Offscreen document: runs the multi-threaded WASM prover.
//
// Why this exists: the wallet's MV3 service worker can't spawn Web Workers,
// so wasm-bindgen-rayon's `initThreadPool(n)` would fail there (or, worse,
// silently spin up a 1-thread pool that pretends to be parallel). The
// offscreen API exists for exactly this kind of "I need a real document
// context for Workers / SAB" need. The SW creates this doc once, this doc
// brings up the rayon pool over its hardware concurrency, then sits waiting
// for prove requests via chrome.runtime.sendMessage.
//
// Lifecycle: created lazily by the SW on first prove (see src/workers/sw
// init). Not closed proactively — Chrome may reap it under memory pressure;
// SW handles recreation. ~120-150 MB always-resident while the doc lives.
//
// Message protocol (chrome.runtime), two families sharing this one doc/channel:
//   OFFSCREEN_PROVE (unchanged):
//     request:  { target: "offscreen", type: "OFFSCREEN_PROVE",
//                 txResultB64: string, proverDescriptor: string | null }
//     response: { ok: true, provenB64: string, durationMs: number }
//             | { ok: false, error: string }
//   OFFSCREEN_CALL (issue #260 — generalized WASM-client method dispatch):
//     request:  { target: "offscreen", type: "OFFSCREEN_CALL", op_id, method,
//                 argsB64: string[], deadline_ms: number | null }
//     response: { ok: true, op_id, resultB64: string | null, durationMs }
//             | { ok: false, op_id, error: string, errorCode?: string }
//   See src/lib/miden/back/offscreen-codec.ts for the shared wire format.

import * as sdk from '@miden-sdk/miden-sdk/lazy';

import {
  OFFSCREEN_CALL,
  b64ToBytes,
  bytesToB64,
  decodeArg,
  type OffscreenCallRequest
} from 'lib/miden/back/offscreen-codec';
import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import type { MidenClientInterface } from 'lib/miden/sdk/miden-client-interface';

const TAG = '[offscreen-prover]';

let initPromise: Promise<void> | null = null;

async function init() {
  // Force WASM init (lazy entry doesn't auto-load) so the wasm-bindgen `wasm`
  // namespace is populated and `initThreadPool` can call into it.
  // getWasmOrThrow → ensureWasm → loadWasm → import('Cargo-*.js') + __wbg_init
  await (sdk as any).getWasmOrThrow();

  // Bring up the rayon thread pool inside THIS document's WASM instance.
  // Each context (SW, offscreen, popup, worker) has its own per-instance
  // global rayon pool — initialization in one doesn't propagate. SAB +
  // crossOriginIsolated are the prerequisites; the manifest's COOP/COEP
  // grant both for chrome-extension:// pages.
  // eslint-disable-next-line no-restricted-globals -- offscreen doc IS a window-like global; `self.crossOriginIsolated` is the canonical check.
  if (!self.crossOriginIsolated) {
    console.warn(
      `${TAG} crossOriginIsolated=false — SharedArrayBuffer unavailable, mt-wasm will fall back to single-thread`
    );
  }
  const initThreadPool = (sdk as any).initThreadPool;
  if (typeof initThreadPool === 'function') {
    const threads = navigator.hardwareConcurrency ?? 4;
    const t = performance.now();
    await initThreadPool(threads);
    console.log(`${TAG} initThreadPool(${threads}) took ${(performance.now() - t).toFixed(0)}ms`);
  } else {
    console.warn(`${TAG} initThreadPool not exported — SDK build is single-threaded`);
  }
}

function ensureInit(): Promise<void> {
  if (!initPromise) initPromise = init();
  return initPromise;
}

// One-shot signal so the SW can tell whether the doc finished bringing up
// the rayon pool. The SW does ensureOffscreenDocument() then waits for
// `OFFSCREEN_READY`, so the first prove doesn't race against the cold start.
ensureInit()
  .then(() => {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(() => {
      /* SW may not be listening yet — that's fine, it'll ping us */
    });
  })
  .catch(err => {
    console.error(`${TAG} init failed:`, err);
  });

// One raw wasm-bindgen WebClient instance, reused across prove calls. The
// SDK's export naming is treacherous: `WebClient` is the RAW wasm-bindgen
// class, while `WasmWebClient` is the worker-shim JS wrapper. The raw class
// is load-bearing here, for two reasons:
//   1. The prove must run in THIS document's WASM instance — the one whose
//      rayon pool init() just brought up. The wrapper forwards every method
//      to its own method worker, a separate WASM instance whose pool this
//      document never initialized.
//   2. The wrapper's constructor implicitly INITs that worker via
//      createClient(rpcUrl=undefined), which on 0.15 performs an eager RPC
//      genesis fetch against the default endpoint. If that fails (wrong
//      network version, offline), the wrapper's `ready` promise never
//      settles and every method call awaits it forever — a silent hang.
// We never call createClient(...) so this stays a "prover-only" client.
// Proving with an explicit prover on an uninitialized client requires
// web-sdk >= 0.15.0-alpha.6; older builds throw "Client not initialized"
// (loud and immediate, never a hang).
let prover: any = null;
function getProver() {
  if (!prover) prover = new (sdk as any).WebClient();
  return prover;
}

// --- Generalized OFFSCREEN_CALL surface (issue #260, slice 1) ---------------
//
// Alongside the prover-only raw WebClient above, the offscreen doc now owns the
// FULL MidenClientInterface singleton (design §3.4) — the same client the SW
// used to run inline. `OFFSCREEN_CALL` messages dispatch a method against it
// and stream the (serialized) result back. Slice 1 wired `getAccount`; slice 3
// extends the DISPATCH table with the remaining serialization-clean reads
// (`syncState`, `exportNote`, `getInputNoteDetails`); later slices add writes.
//
// State-across-reopen correctness rests on IndexedDB: `closeDocument()` discards
// the WASM heap by design, and a reopened client re-attaches to the same store.

/** method -> (client, ...decodedArgs) -> serialized result bytes (or null). Each
 * entry serializes its own result so the transport only base64-encodes bytes
 * (design §1.4 rule 1: pass `serialize()` bytes where the SDK exposes them). */
type DispatchFn = (client: MidenClientInterface, ...args: any[]) => Promise<Uint8Array | null>;

const DISPATCH: Record<string, DispatchFn> = {
  getAccount: async (client, accountId: string) => {
    const account = await client.getAccount(accountId);
    // `Account` exposes serialize()/deserialize() (verified in the SDK types),
    // so we ship the full object as bytes and the SW re-hydrates it.
    return account ? (account.serialize() as Uint8Array) : null;
  },

  // Read-method surface (issue #260, slice 3). Each stays serialization-clean:
  // its result crosses the message boundary either as SDK-serialized bytes,
  // a plain-JSON DTO, or nothing at all. (getConsumableNotes / getInputNote are
  // intentionally NOT here — their raw `InputNoteRecord` has no serialize() and
  // callers reach through to live wasm-bindgen methods, so they stay SW-inline.)

  syncState: async client => {
    // Run the sync; every SW-side caller discards the returned `SyncSummary`,
    // so return null. Nothing to serialize here means nothing to re-hydrate on
    // the SW — serializing a result no one reads would be pure waste.
    await client.syncState();
    return null;
  },

  exportNote: async (client, noteId: string, exportType) => {
    // `exportNote` already returns serialized note bytes — ship them verbatim;
    // the SW hands them straight to the intercom without re-hydrating.
    return await client.exportNote(noteId, exportType);
  },

  getInputNoteDetails: async (client, query) => {
    // Plain-DTO result (§1.4 rule "a"): the interface method already reduces
    // each `InputNoteRecord` to a JSON-safe DTO, so JSON-encode it to bytes.
    // `?? undefined` maps a JSON-`null` arg (an `undefined` query round-tripped
    // through encodeArg) back to the SDK's optional-query shape.
    const details = await client.getInputNoteDetails(query ?? undefined);
    return new TextEncoder().encode(JSON.stringify(details));
  },

  // Consumable notes (issue #260, slice 4). The RECLAIM GATE
  // (`consumableAfterBlock() <= getSyncHeight()`) lives inside
  // `getConsumableNoteDtos` → so running it HERE, in the offscreen realm that
  // also ran `syncState`, is the whole point: the gate uses this realm's sync
  // height, not the stale SW-inline one. Result is a plain JSON-safe DTO array
  // carrying every field each caller reads (the live `InputNoteRecord` — with no
  // serializer and callers reaching through to `.id()/.metadata()/…` — cannot
  // itself cross the boundary; the reduced DTO can).
  getConsumableNotes: async (client, accountId: string) => {
    const dtos = await client.getConsumableNoteDtos(accountId);
    return new TextEncoder().encode(JSON.stringify(dtos));
  }
};

// The offscreen-owned client singleton, created lazily on first OFFSCREEN_CALL.
let clientPromise: Promise<MidenClientInterface> | null = null;
function getOrCreateClient(): Promise<MidenClientInterface> {
  if (!clientPromise) {
    // S1: null the cached promise if the create rejects (e.g. a transient RPC
    // genesis fetch failure) so the NEXT OFFSCREEN_CALL retries within this same
    // doc — otherwise a one-off failure would stick until the next kill/reopen.
    clientPromise = getMidenClient().catch((err: unknown) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

async function handleCall(msg: OffscreenCallRequest, sendResponse: (r?: unknown) => void): Promise<void> {
  const t = performance.now();
  try {
    await ensureInit();
    const dispatch = DISPATCH[msg.method];
    if (!dispatch) {
      sendResponse({
        ok: false,
        op_id: msg.op_id,
        error: `Unknown offscreen method '${msg.method}'`,
        errorCode: 'UNKNOWN_METHOD'
      });
      return;
    }
    const client = await getOrCreateClient();
    const args = msg.argsB64.map(decodeArg);
    // W1: serialize actual WASM entry inside THIS doc's own mutex (design §5,
    // §8-risk-5). The offscreen realm has its own module-level `wasmClientMutex`
    // (imported here in the offscreen bundle — distinct from the SW's instance),
    // so two concurrent OFFSCREEN_CALLs can't double-borrow the WASM client's
    // RefCell ("recursive use of an object" crash). The IPC layer already
    // supports >1 in-flight op; this is where they queue. Slice 4's concurrent
    // routes inherit this serialization for free.
    const resultBytes = await withWasmClientLock(() => dispatch(client, ...args));
    sendResponse({
      ok: true,
      op_id: msg.op_id,
      resultB64: resultBytes ? bytesToB64(resultBytes) : null,
      durationMs: performance.now() - t
    });
  } catch (err) {
    console.error(`${TAG} call '${msg?.method}' failed:`, err);
    sendResponse({ ok: false, op_id: msg?.op_id, error: String((err as { message?: string })?.message ?? err) });
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;

  if (msg?.type === 'OFFSCREEN_PROVE') {
    (async () => {
      try {
        await ensureInit();
        const wasmSdk = sdk as any;
        const txResultBytes = b64ToBytes(msg.txResultB64 as string);
        const txResult = wasmSdk.TransactionResult.deserialize(txResultBytes);
        // SDK 0.14.6+: TransactionProver.deserialize is async (the "gpu"
        // descriptor re-acquires a wgpu::Device, which is async). For "local"
        // and "remote|..." descriptors the call is still effectively sync but
        // returns a Promise — must be awaited.
        const proverObj = msg.proverDescriptor
          ? await wasmSdk.TransactionProver.deserialize(msg.proverDescriptor)
          : wasmSdk.TransactionProver.newLocalProver();
        const t = performance.now();
        const proven = await getProver().proveTransaction(txResult, proverObj);
        const ms = performance.now() - t;
        console.log(`${TAG} prove duration_ms=${ms.toFixed(1)}`);
        const provenBytes = proven.serialize() as Uint8Array;
        sendResponse({ ok: true, provenB64: bytesToB64(provenBytes), durationMs: ms });
      } catch (err) {
        console.error(`${TAG} prove failed:`, err);
        sendResponse({ ok: false, error: String((err as { message?: string })?.message ?? err) });
      }
    })();
    // Returning true tells Chrome we'll call sendResponse async.
    return true;
  }

  if (msg?.type === OFFSCREEN_CALL) {
    void handleCall(msg as OffscreenCallRequest, sendResponse);
    // Returning true tells Chrome we'll call sendResponse async.
    return true;
  }

  return false;
});

console.log(`${TAG} loaded`);
