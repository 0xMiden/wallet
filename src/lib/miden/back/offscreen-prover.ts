// Service-worker-side helpers for the offscreen prover document.
//
// Why offscreen: the wallet's MV3 service worker can't spawn Web Workers, so
// `wasm-bindgen-rayon::initThreadPool(n)` would silently produce a 1-thread
// pool. We delegate the prove step to a chrome.offscreen document, which is
// a real document context that can spawn Workers + use SharedArrayBuffer
// (the manifest's COOP/COEP grant cross-origin isolation on chrome-extension
// pages, and we declare `offscreen` permission).
//
// Lifecycle: `ensureOffscreenDocument()` is idempotent — it checks
// `chrome.offscreen.hasDocument()` and only creates if missing. Chrome may
// reap the document under memory pressure; the next `ensureOffscreenDocument`
// recreates it. Cold start re-pays WASM init + thread-pool spawn (~1-3s).

const OFFSCREEN_URL = 'offscreen.html';
let creationPromise: Promise<void> | null = null;

/**
 * True iff the runtime exposes the `chrome.offscreen` API. Chrome MV3 only
 * — Firefox WebExtensions and Safari extensions don't have it. Callers
 * should branch on this and fall through to a single-threaded prove path
 * when false. The caller-facing prove dispatcher
 * (MidenClientInterface.shouldUseOffscreenProver) does this; consumers of
 * proveViaOffscreen() directly should also gate on this if they want a
 * clean fallback rather than a thrown error.
 */
export function isOffscreenAvailable(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    typeof (chrome as { offscreen?: unknown }).offscreen !== 'undefined' &&
    typeof chrome.offscreen.createDocument === 'function'
  );
}

async function hasOffscreenDocument(): Promise<boolean> {
  // chrome.offscreen.hasDocument() is the supported API on Chrome 116+.
  // `clients.matchAll({ includeUncontrolled: true })` was the older
  // workaround when the API wasn't available; we don't bother since the
  // wallet's manifest already requires Chrome 114+.
  if ((chrome.offscreen as { hasDocument?: () => Promise<boolean> }).hasDocument) {
    return chrome.offscreen.hasDocument();
  }
  // Fallback: try to query via clients API (works in any MV3 SW)
  // eslint-disable-next-line no-restricted-globals -- this file runs in the SW; `self.clients` is the only way to enumerate offscreen docs on Chrome <116.
  const swSelf = self as unknown as {
    clients: {
      matchAll: (opts: { type: string; includeUncontrolled: boolean }) => Promise<{ url: string }[]>;
    };
  };
  const all = await swSelf.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return all.some(c => c.url.endsWith(OFFSCREEN_URL));
}

export async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) return;
  // Coalesce concurrent callers — chrome.offscreen.createDocument throws
  // if a doc already exists, which would race two concurrent ensure calls.
  if (creationPromise) {
    await creationPromise;
    return;
  }
  creationPromise = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        // 'WORKERS' is the documented justification for needing Web Workers.
        reasons: ['WORKERS' as chrome.offscreen.Reason],
        justification:
          'Multi-threaded WASM proving via wasm-bindgen-rayon. SWs cannot spawn Web Workers; this document hosts the rayon thread pool used by the Miden prover.'
      });
      // Wait for the offscreen doc to signal it finished init (rayon pool up,
      // WASM loaded). Without this gate the first prove races against the
      // cold start and the message lands on a not-yet-ready listener.
      await waitForOffscreenReady();
    } finally {
      creationPromise = null;
    }
  })();
  await creationPromise;
}

function waitForOffscreenReady(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(handler);
      reject(new Error('Offscreen prover ready signal timed out (>30s)'));
    }, 30_000);
    const handler = (msg: { type?: string }) => {
      if (msg?.type === 'OFFSCREEN_READY') {
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(handler);
        resolve();
      }
    };
    chrome.runtime.onMessage.addListener(handler);
  });
}

export type ProveViaOffscreenResult = {
  provenBytes: ArrayBufferLike;
  durationMs: number;
};

/**
 * Send an executed `TransactionResult` (serialized bytes) to the offscreen
 * prover and await the proven `ProvenTransaction` (serialized bytes).
 *
 * `proverDescriptor` is the string returned by `TransactionProver.serialize()`
 * — `"local"` or `"remote|<endpoint>[|<timeout_ms>]"`. Pass `null` to make
 * the offscreen doc construct a fresh local prover (the common case).
 */
export async function proveViaOffscreen(
  txResultBytes: Uint8Array,
  proverDescriptor: string | null
): Promise<ProveViaOffscreenResult> {
  await ensureOffscreenDocument();
  // chrome.runtime.sendMessage's payload IS structured-cloned in modern
  // Chrome, but ArrayBuffer/Uint8Array round-tripping has been flaky in
  // practice (we hit "unexpected end of file" deserializing on the other
  // side, suggesting the bytes either don't traverse intact or the receiver
  // sees an empty TypedArray). Encode as base64 — JSON-safe, zero ambiguity,
  // and the encode/decode cost is single-digit ms for the proof-shaped
  // blobs we move (sub-MB).
  const txResultB64 = bytesToB64(txResultBytes);
  const response = (await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'OFFSCREEN_PROVE',
    txResultB64,
    proverDescriptor
  })) as { ok: true; provenB64: string; durationMs: number } | { ok: false; error: string } | undefined;
  if (!response) {
    throw new Error('Offscreen prover returned no response (doc may have been reaped)');
  }
  if (!response.ok) {
    throw new Error(`Offscreen prove failed: ${response.error}`);
  }
  const provenBytes = b64ToBytes(response.provenB64).buffer;
  return { provenBytes, durationMs: response.durationMs };
}

function bytesToB64(bytes: Uint8Array): string {
  // Chunked to avoid the call-stack-size limit on apply for large arrays;
  // 0x8000 keeps each call's argument count well under any sane limit.
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
