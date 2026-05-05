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
// Message protocol (chrome.runtime):
//   request:  { type: "OFFSCREEN_PROVE", txResultBytes: ArrayBuffer,
//               proverDescriptor: string | null }
//   response: { ok: true, provenBytes: ArrayBuffer } | { ok: false, error: string }

import * as sdk from '@miden-sdk/miden-sdk/lazy';

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

// One barebones WebClient instance, reused across prove calls. WebClient
// has internal state (cached buffers, key store) but proveTransactionWithProver
// is computational — no RPC, no DB. We don't call createClient(...) so it
// stays a "prover-only" client. If a future SDK version requires init for
// proving, we'll need to plumb rpcUrl + storeName through here.
let prover: any = null;
function getProver() {
  if (!prover) prover = new (sdk as any).WasmWebClient();
  return prover;
}

function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(s);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || msg?.type !== 'OFFSCREEN_PROVE') return false;
  (async () => {
    try {
      await ensureInit();
      const wasmSdk = sdk as any;
      const txResultBytes = b64ToBytes(msg.txResultB64 as string);
      const txResult = wasmSdk.TransactionResult.deserialize(txResultBytes);
      const proverObj = msg.proverDescriptor
        ? wasmSdk.TransactionProver.deserialize(msg.proverDescriptor)
        : wasmSdk.TransactionProver.newLocalProver();
      const t = performance.now();
      const proven = await getProver().proveTransactionWithProver(txResult, proverObj);
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
});

console.log(`${TAG} loaded`);
