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
//   OFFSCREEN_RELOAD_ENDPOINTS (developer endpoint overrides):
//     request:  { target: "offscreen", type: "OFFSCREEN_RELOAD_ENDPOINTS" }
//     response: { ok: true } | { ok: false, error: string }
//   See src/lib/miden/back/offscreen-codec.ts for the shared wire format, which
//   also defines the REVERSE (offscreen → SW) families this realm posts: the sign
//   round-trip, the execution-start signal, the per-step stage stamps, and
//   OFFSCREEN_CONNECTIVITY_EVENT (this realm's connectivity observations, reported
//   into the SW-owned snapshot rather than written to storage here).

import * as sdk from '@miden-sdk/miden-sdk/lazy';

import { setConnectivityReporter, type ConnectivityCategory } from 'lib/miden/activity/connectivity-state';
import {
  OFFSCREEN_CALL,
  OFFSCREEN_CONNECTIVITY_EVENT,
  OFFSCREEN_OP_STARTED,
  OFFSCREEN_RELOAD_ENDPOINTS,
  OFFSCREEN_SIGN_REQUEST,
  OFFSCREEN_STAGE_EVENT,
  SW_TARGET,
  b64ToBytes,
  bytesToB64,
  decodeArg,
  errorNameOf,
  type OffscreenCallRequest,
  type OffscreenConnectivityEvent,
  type OffscreenOpStarted,
  type OffscreenReloadEndpointsResponse,
  type OffscreenSignResponse,
  type OffscreenStageEvent
} from 'lib/miden/back/offscreen-codec';
import type { ConsumeTransaction, ITransactionStage, SendTransaction, SwapTransaction } from 'lib/miden/db/types';
import { collectInputNoteDetails } from 'lib/miden/sdk/input-note-detail';
import { reduceInputNoteSummary } from 'lib/miden/sdk/input-note-summary';
import {
  type WasmLockHold,
  getCurrentWasmLockHold,
  onWasmClientPoisoned,
  withWasmClientLock,
  withWasmLockWatchdogPaused,
  yieldWasmClientLock
} from 'lib/miden/sdk/miden-client';
import { MidenClientInterface, remoteProver, withDelegatedProveTimeout } from 'lib/miden/sdk/miden-client-interface';
import { recordProveMarker } from 'lib/miden/sdk/prove-telemetry';
import { reducePswapLineage } from 'lib/miden/sdk/pswap-lineage';
import { extractSdkErrorCode } from 'lib/miden/sdk/sdk-error-code';
import { poisonReasonOf, wasmClientGeneration } from 'lib/miden/sdk/wasm-client-poison';
import { loadEndpointOverrides } from 'lib/miden-chain/effective-endpoints';

const TAG = '[offscreen-prover]';

// Mark THIS realm as the offscreen document (issue #260 flip-prep #4). Set at
// module top, before any client is created or any write executes, so the
// version-independent `isInOffscreenDocument()` recursion guard
// (offscreen-prover.ts) can short-circuit `isOffscreenAvailable()` to false here.
// That makes a non-guardian offscreen write prove LOCALLY in-realm (on this doc's
// `useWorker:false` WASM) instead of trying to re-dispatch OFFSCREEN_PROVE to a
// non-existent handler inside the doc — which would fail EVERY such write. It does
// NOT depend on `chrome.offscreen` being absent inside the doc (an unreliable
// Chrome quirk); the guard reads this deterministic global.
(globalThis as { __MIDEN_IN_OFFSCREEN_DOC__?: boolean }).__MIDEN_IN_OFFSCREEN_DOC__ = true;

// --- E2E-only per-call markers for THIS realm (#718) ------------------------
//
// The realm that runs every wallet write is the one realm the Playwright harness
// cannot attach a console to: the offscreen document is a hidden target, absent
// from `context.pages()`. `recordProveMarker` is the way out — it relays each line
// to the service worker, which appends it to `miden_prove_markers_offscreen` for
// the harness's prove-telemetry probe to read.
//
// WHY THIS FILE NEEDS ITS OWN MARKERS, given that `MidenClientInterface` is already
// instrumented and IS bundled into this realm (it reaches here through the shared
// `chunks/miden-client.*.js` that `offscreen.js` imports — a `grep offscreen.js`
// alone misses it and reads as "not instrumented"): the interface's markers only
// narrate the writes that go THROUGH it. The dispatch table below reaches past it
// in two places that then narrate nothing at all — `guardianPipeline`, which drives
// the raw `client.client.transactions` API itself, and the op ENVELOPE in
// `handleCall`, which is where an op waits on the WASM mutex, builds the client and
// hydrates WASM. A guardian write — the wallet's DEFAULT account type — is
// therefore entirely invisible today, which is exactly the write that hangs.
//
// Settle-time prove telemetry cannot answer this either: it records once a prove
// FINISHES, so a prove that never returns contributes nothing and its absence is
// indistinguishable from "no prove was attempted". These markers are written as
// they happen, so the LAST one names the call this realm is still sitting in.
//
// Gated on the E2E build flag, so production records nothing. Mirrors the identical
// helper in `sdk/miden-client-interface` and `sdk/native-prover-mobile`; kept local
// rather than shared because the gate is a build-time constant each bundle folds
// away on its own, and importing a shared wrapper would defeat that.
const PROVE_TIMING_ENABLED = process.env.MIDEN_E2E_TEST === 'true';

function recordProveTiming(message: string): void {
  if (!PROVE_TIMING_ENABLED) return;
  const line = `[prove-timing] ${TAG} ${message}`;
  console.log(line);
  recordProveMarker(line);
}

// --- Connectivity marks REPORT to the SW, they do not write storage ---------
//
// `lib/miden/activity/connectivity-state` keeps its snapshot in module scope — i.e.
// PER REALM — and mirrors the WHOLE snapshot to the single shared storage key the
// banner reads. Both realms reach that module: the SW marks `node`/`network` from
// sync-manager AND `prover` from the guardian requeue branch of the transaction loop
// it owns (`transaction/index.ts`), while THIS realm marks/clears `prover` on every
// write it executes (`proveWithFallback`). Neither has seen the other's issues, so
// whichever writes last replaces the entire picture — an offscreen prover SUCCESS
// would clear a real "node unreachable" banner, which is precisely the surface
// telling the user whether the wallet can reach the network.
//
// So this realm becomes a REPORTER: every mark/clear is forwarded to the SW, which
// owns the snapshot and applies it category-by-category. Installed at module top,
// before any client exists and before any handler can run, so no observation in this
// realm can take the storage-writing path.
//
// Fire-and-forget, and safe to drop / delay / reorder by construction: a reporting
// realm keeps no local state and so never de-duplicates — it RE-SENDS rather than
// sending deltas (see `setConnectivityReporter`) — and the SW applies each report by
// writing it THROUGH (`applyConnectivityReport` — the de-duplicating mutators would
// skip the storage mirror a re-send has to repair). Those two halves together are what
// bound a lost event to a stale banner instead of a latched wrong state; the only
// consumer is the banner, and nothing downstream makes a correctness decision on it.
//
// The re-send CADENCE, precisely, is `proveWithFallback`'s two call sites
// (`sdk/miden-client-interface.ts`): `prover: false` after every prove that succeeds on
// its first attempt, and `prover: true` after every DELEGATED prove that fails with a
// transport-shaped error. Nothing is sent when a non-delegated prove throws, when a
// delegated failure is not transport-shaped, or on the local re-prove that rescues a
// delegated failure. So a dropped clear costs staleness until the next first-attempt
// success and a dropped mark until the next delegated network failure — bounded and
// cosmetic, but not literally "the next prove".
function postConnectivityEvent(category: ConnectivityCategory, active: boolean): void {
  const event: OffscreenConnectivityEvent = {
    target: SW_TARGET,
    type: OFFSCREEN_CONNECTIVITY_EVENT,
    category,
    active
  };
  try {
    // Same two-layer swallow as `postStageEvent`: `Promise.resolve(...)` tolerates a
    // mock/polyfilled sendMessage returning a non-promise and absorbs a rejection
    // (no SW receiver), the outer catch absorbs a synchronous throw (torn-down port).
    // Both matter more here than for a stamp: these calls sit INSIDE the prove path's
    // success/failure handlers, where a throw would be read as a prove failure.
    void Promise.resolve(chrome.runtime.sendMessage(event)).catch(() => {});
  } catch {
    /* a synchronous sendMessage throw must not reach the prove — see above */
  }
}

setConnectivityReporter(postConnectivityEvent);

// --- Developer endpoint overrides in THIS realm -----------------------------
//
// `loadEndpointOverrides()` is the ONLY writer of the override cache in
// `lib/miden-chain/effective-endpoints`, and that cache is module-scoped — i.e.
// per realm. The service worker loads it at its own boot (`lib/miden/back/main.ts`)
// and the page realm at provider mount, but neither reaches here, so without this
// load every `getEffective*Url()` / `getEffectiveNetworkName()` in the offscreen
// document answers the BUILD DEFAULT no matter what the user saved. Two things
// break at once when the offscreen client is enabled (`MIDEN_USE_OFFSCREEN_CLIENT`,
// which `vite.background.config.ts` defaults ON for the service worker):
//   1. WRONG NODE. `MidenClientInterface.create` BAKES rpcUrl / proverUrl /
//      noteTransportUrl into the client, and flag-on that client runs every
//      send/consume/swap/newTransaction, every syncState, note import/export and
//      the private-note relay — so a wallet configured on a custom dev-settings
//      network would do all of its real work against the default node.
//   2. SPLIT BECH32 PREFIX. `getNetworkId()` reads the network NAME, which an
//      override can change independently of the RPC URL (the localnet preset uses
//      the `mlcl` HRP), so ids encoded here would carry a different prefix than the
//      ids the SW encodes, and SW-side comparisons between the two could never match.
//
// Memoized so the storage read happens once per realm. The memo is deliberately a
// NEVER-REJECTING shadow of the load: it is awaited on the client-creation path, and
// a permanently-rejected slot there would fail every later `getOrCreateClient()`.
// (`loadEndpointOverrides` already swallows its own storage errors — falling back to
// "no override" — so the catch only covers the unexpected.)
let endpointOverridesPromise: Promise<void> | null = null;

function ensureEndpointOverrides(): Promise<void> {
  if (!endpointOverridesPromise) endpointOverridesPromise = loadEndpointOverrides().catch(() => {});
  return endpointOverridesPromise;
}

let initPromise: Promise<void> | null = null;

async function init() {
  // Hydrate the endpoint override FIRST, mirroring the service worker's own boot
  // order (load, then everything else): `ensureInit()` is awaited at the top of
  // every inbound message handler, so completing the load here orders it ahead of
  // anything in this realm that could build a client or encode an account id.
  // `getOrCreateClient()` awaits the same memoized load again at the creation site
  // itself, so the ordering does not depend on that call chain staying intact.
  await ensureEndpointOverrides();

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

// --- Reverse-IPC sign stub (issue #260, slice 5, design §2.4) ---------------
//
// The offscreen client is created with `keystore.sign = offscreenSignViaSW`, so
// when a write op's execute step needs a signature the SDK invokes THIS stub. It
// can't reach the SW's decrypted vault directly, so the sign REVERSES across the
// bus: post the raw `(pubkey, signingInputs)` bytes to the SW tagged for its
// reverse-IPC handler, await the raw signature bytes. Only bytes cross — no SDK
// handle is ever involved in signing.

// The op_id of the OFFSCREEN_CALL currently executing in this realm. Stashed by
// `handleCall` right before it invokes the DISPATCH fn (under the WASM mutex, so
// only one op runs at a time — no concurrent overwrite) so the sign stub can tag
// its request with the write op the signature belongs to (design §2.4, §2.5).
//
// Post-flip hazard 2 (issue #260 follow-up #2): now that the commit-wait dispatch
// YIELDS the WASM mutex during its inter-poll sleeps (follow-up #1), an interloper
// op runs during that sleep and overwrites/clears this global. The commit-wait
// never signs, so this is harmless for the wait itself, but the invariant "the sign
// stub reads THIS op's id" is restored as insurance (and to unblock a future
// in-doc prove-yield): each dispatch that yields captures `reassertCurrentOpId`
// LOCALLY (below) before its first yield and re-asserts after each one.
let currentOpId: string | null = null;

// Re-asserts `currentOpId` to the op that is currently executing. `handleCall` sets
// this to a fresh closure BOUND to the op's id (alongside `currentOpId`), and a
// dispatch that yields the WASM mutex captures it into a LOCAL variable before its
// first yield. Local capture is what makes it interloper-proof: an op that runs
// during the yield overwrites this module global with ITS own reassert, but the
// yielding op already holds a reference to its own, so calling that restores the
// correct id (issue #260 follow-up #2).
let reassertCurrentOpId: () => void = () => {};

function newSignId(): string {
  // The offscreen document is a window context, so `crypto.randomUUID` is always
  // present (unlike the SW's defensive `newOpId` fallback).
  return crypto.randomUUID();
}

/**
 * Per-client liveness for the sign stub (issue #775).
 *
 * `currentOpId` is a module global, so clearing it at eviction only covers the
 * window before a SUCCESSOR op sets its own — after that, an abandoned
 * dispatch's mid-execute sign would read the successor's id and look perfectly
 * well-formed. The corpse and the successor cannot be told apart by the id;
 * they CAN be told apart by the client, because recovery rebuilds it. So each
 * created client gets its own sign closure over its own liveness token, and
 * poisoning marks that token: the corpse's sign then fails on its own identity
 * no matter whose id is ambient.
 */
type SignLiveness = { poisoned: boolean };

/**
 * Liveness of the most recently CREATED client — the one to mark on poison.
 *
 * Deliberately not "the one in `clientPromise`": `reloadEndpointOverrides()`
 * clears that slot without touching this, so between a reload and the next
 * `getOrCreateClient()` this names a client no longer installed. That is still
 * the right target, because it is the client any in-flight dispatch is running
 * on, and a trap aborts the WASM module they all share.
 */
let currentSignLiveness: SignLiveness | null = null;

const makeOffscreenSignViaSW =
  (liveness: SignLiveness) =>
  async (publicKey: Uint8Array, signingInputs: Uint8Array): Promise<Uint8Array> => {
    if (liveness.poisoned) {
      // This client was displaced by lock recovery, so whoever is calling is an
      // abandoned dispatch (issue #775). Its signature would be attributed to
      // whichever op holds the lock NOW — pausing that op's write deadline and
      // letting this failure land in the successor's `locked` slot.
      throw new Error('offscreen sign: this client was poisoned by WASM lock recovery');
    }
    return offscreenSignViaSW(publicKey, signingInputs);
  };

async function offscreenSignViaSW(publicKey: Uint8Array, signingInputs: Uint8Array): Promise<Uint8Array> {
  const op_id = currentOpId;
  if (!op_id) {
    // A sign fired outside an OFFSCREEN_CALL — should be impossible (signing only
    // happens inside a dispatched write op). Fail loud rather than sign untagged.
    throw new Error('offscreen sign: no ambient op_id (sign fired outside an OFFSCREEN_CALL)');
  }
  const sign_id = newSignId();
  // A sign that never answers stalls the execute step with the WASM mutex held, and
  // is invisible from the SW side because the op's deadline is PAUSED for the whole
  // round-trip (design §2.5) — so it cannot even be distinguished from a slow prove.
  recordProveTiming(`sign requested op=${op_id} sign=${sign_id}`);
  const resp = (await chrome.runtime.sendMessage({
    target: SW_TARGET,
    type: OFFSCREEN_SIGN_REQUEST,
    op_id,
    sign_id,
    publicKeyB64: bytesToB64(publicKey),
    signingInputsB64: bytesToB64(signingInputs)
  })) as OffscreenSignResponse | undefined;
  recordProveTiming(`sign answered op=${op_id} sign=${sign_id} ok=${resp?.ok === true}`);
  if (!resp || !resp.ok) {
    // Throw so the SDK's WebKeyStore captures it (offscreen `lastAuthError`) and
    // the execute fails; the SW-side handler already recorded the classified
    // reason authoritatively for the locked-defer path (design §2.6).
    throw new Error(`offscreen sign failed: ${resp && !resp.ok ? resp.error : 'no response from SW'}`);
  }
  return b64ToBytes(resp.signatureB64);
}

// --- Reverse per-step stage stamps (PR #524 across the #260 boundary) --------
//
// The staged send drives execute → prove → submit itself so the UI can time each
// step; those stamps live on the SW's transaction ROW, which this realm knows
// nothing about. So the stamp reverses across the bus tagged with an op_id, and
// the SW maps it back to the row via the stage callback it registered for that op.
//
// The op_id is PASSED IN, captured once per dispatch (see `dispatchContext`) —
// deliberately not read from the ambient `currentOpId` at post time, which the
// sign stub has to do because the SDK invokes it with no context of its own. A
// stamp is not attribution-neutral: `stageStampFor` turns a 'submitting' stamp
// into `markMayHaveSubmitted(txId)`, so an evicted dispatch that kept running
// and stamped under the ambient id would mark the SUCCESSOR's row as
// possibly-broadcast and make the wallet refuse to retry a send that never
// happened (issue #775).
//
// Three ways this deliberately differs from `offscreenSignViaSW`, all because a
// stamp is telemetry and a signature is the transaction:
//   1. FIRE-AND-FORGET. Nothing is awaited, so the prove path is never gated on
//      the SW answering (or existing).
//   2. NEVER THROWS. A `sendMessage` that rejects (no receiver) or throws
//      synchronously (a torn-down port) is swallowed — losing a stamp costs one
//      blank duration in the UI; throwing here would fail a funds-moving send.
//   3. A MISSING op_id is skipped, not fatal. Signing fails loud without one
//      because an untagged signature is a bug; an untagged stamp is simply
//      undeliverable, so there is nothing to do but drop it.
//
// A stamp from a dispatch that has already SETTLED is dropped too. Binding the
// id fixes attribution but not time: an evicted dispatch keeps running, and a
// stamp it fires afterwards is correctly addressed to a row the SW has already
// moved past — 'proving' arriving after the row completed would rewind the UI,
// and 'submitting' would set may-have-submitted on a row already adjudicated.
function postStageEvent(context: DispatchContext, stage: ITransactionStage): void {
  const { op_id } = context;
  if (!op_id || context.settled) return;
  const event: OffscreenStageEvent = { target: SW_TARGET, type: OFFSCREEN_STAGE_EVENT, op_id, stage };
  try {
    // `Promise.resolve(...)` tolerates a mock/polyfilled sendMessage that returns a
    // non-promise, exactly as the OFFSCREEN_OP_STARTED post does; the response (if
    // any) is intentionally ignored.
    void Promise.resolve(chrome.runtime.sendMessage(event)).catch(() => {});
  } catch {
    /* a synchronous sendMessage throw must not reach the write — see (2) above */
  }
}

// --- Generalized OFFSCREEN_CALL surface (issue #260, slice 1) ---------------
//
// Alongside the prover-only raw WebClient above, the offscreen doc now owns the
// FULL MidenClientInterface singleton (design §3.4) — the same client the SW
// used to run inline. `OFFSCREEN_CALL` messages dispatch a method against it
// and stream the (serialized) result back. Slice 1 wired `getAccount`; slice 3
// extends the DISPATCH table with the remaining serialization-clean reads
// (`syncState`, `exportNote`, `getInputNoteDetails`); slice 4 added
// `getConsumableNotes`; slice 5 adds the first WRITE, `consumeNoteId`.
//
// State-across-reopen correctness rests on IndexedDB: `closeDocument()` discards
// the WASM heap by design, and a reopened client re-attaches to the same store.

/** method -> (client, ...decodedArgs) -> serialized result bytes (or null). Each
 * entry serializes its own result so the transport only base64-encodes bytes
 * (design §1.4 rule 1: pass `serialize()` bytes where the SDK exposes them). */
type DispatchFn = (client: MidenClientInterface, ...args: any[]) => Promise<Uint8Array | null>;

/**
 * One dispatch's own identity: the op it serves and the WASM lock hold it runs
 * under, plus whether it has settled.
 *
 * It exists because none of the three can be read safely later. `currentOpId` is
 * overwritten by the next op, and `getCurrentWasmLockHold()` returns whoever
 * holds the mutex NOW — which for an evicted dispatch that kept running is the
 * successor. Anything read at that point silently belongs to somebody else: a
 * stage stamp lands on the successor's row, and a watchdog pause silences the
 * successor's backstop (issue #775).
 */
type DispatchContext = {
  readonly op_id: string;
  readonly hold: WasmLockHold | null;
  /** Set by `handleCall` when the dispatch settles; see `postStageEvent`. */
  settled: boolean;
};

/**
 * The context of the dispatch currently being STARTED. Published by `handleCall`
 * immediately before it invokes the dispatch, with no await in between, so a
 * dispatch that takes it in its own first synchronous statement provably gets
 * its OWN identity.
 */
let startingDispatch: DispatchContext | null = null;

/**
 * Take the identity of the dispatch being started. MUST be called from a
 * dispatch's first synchronous statement — see {@link startingDispatch}. Cleared
 * on read so a later (invalid) call cannot pick up somebody else's identity.
 */
function dispatchContext(): DispatchContext {
  const context = startingDispatch;
  startingDispatch = null;
  if (!context) {
    // Only reachable if a dispatch reads this after an await, or outside
    // `handleCall` entirely. Fail loud rather than guess an identity: guessing is
    // exactly the bug this replaces.
    throw new Error('offscreen dispatch: no dispatch context (read it in the first statement of the dispatch)');
  }
  return context;
}

const DISPATCH: Record<string, DispatchFn> = {
  getAccount: async (client, accountId: string) => {
    const account = await client.getAccount(accountId);
    // `Account` exposes serialize()/deserialize() (verified in the SDK types),
    // so we ship the full object as bytes and the SW re-hydrates it.
    return account ? (account.serialize() as Uint8Array) : null;
  },

  // Read-method surface (issue #260, slices 3+). Each stays serialization-clean:
  // its result crosses the message boundary either as SDK-serialized bytes, a
  // plain-JSON DTO, or nothing at all. The raw `InputNoteRecord` / consumable-note
  // records still have no serialize() and can't themselves cross — but the reads
  // that reach through them (`getConsumableNotes`, slice 4; `getInputNoteSummary`
  // and `getSerializedInputNoteDetails`, slice 7-reads) now run their reduction
  // HERE, in-realm, so only the reduced plain DTO crosses. That in-realm reduction
  // is the whole point once the flag is on: the offscreen client owns the canonical
  // synced state, so these reads no longer go stale against the dormant SW client.

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

  // Node-authoritative commit state of one tx id, backing the send/swap
  // idempotent-retry guard. A plain string union, so JSON like the DTO reads
  // above. Its absence here was not neutral: the SW-side stub returned
  // 'not-found', which `verifySendLanded` maps to 'unknown' — "cannot prove it
  // landed" — and the retry proceeds on that. So on the flag-on path, which is
  // the default in the service worker, the guard could never fire and a Failed
  // row whose submit had actually landed was resubmitted.
  getTransactionCommitState: async (client, txId: string) => {
    const state = await client.getTransactionCommitState(txId);
    return new TextEncoder().encode(JSON.stringify(state));
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
  },

  // Deferred reach-through READS moved offscreen (issue #260, slice 7a). Each reads
  // the OFFSCREEN client's canonical synced state — the whole point, since flag-on
  // the SW client is dormant and these formerly read stale data off it. The results
  // are all trivially / cleanly serializable (a number, a plain-JSON DTO, a plain
  // DTO, a string), so nothing reaches through a live wasm-bindgen object across the
  // boundary; the reduction (for the two live-record reads) runs HERE, in-realm.

  // The reclaim-baseline sync height (guardian recallable-send). `fresh` forces a
  // network sync first and returns the just-synced block; otherwise the last-synced
  // height. The number crosses as JSON.
  getSyncHeight: async (client, fresh: boolean) => {
    const height = fresh ? (await client.client.sync()).blockNum() : await client.client.getSyncHeight();
    return new TextEncoder().encode(JSON.stringify(height));
  },

  // A PSWAP order's lineage, reduced in-realm to a plain JSON DTO (the live
  // `PswapLineageRecord` has no serializer and callers reach through its methods).
  // Returns null (→ resultB64 null) when the client isn't tracking the order.
  getPswapLineage: async (client, orderId: string) => {
    const dto = reducePswapLineage(await client.client.pswap.lineage(orderId));
    return dto ? new TextEncoder().encode(JSON.stringify(dto)) : null;
  },

  // A to-be-consumed note's summary, reduced in-realm to a minimal JSON DTO carrying
  // just the note's `noteType`. Returns null (→ resultB64 null) for a not-found note,
  // distinct from a found record whose `noteType` is undefined (the JSON `{}`).
  getInputNoteSummary: async (client, noteId: string) => {
    const dto = reduceInputNoteSummary(await client.getInputNote(noteId));
    return dto ? new TextEncoder().encode(JSON.stringify(dto)) : null;
  },

  // Invalid-note detail for a batch of claimable notes (popup invalid-note detection).
  // Each live `InputNoteRecord` is reduced in-realm to the wire-shaped
  // `SerializedInputNoteDetail` (assets / processing-state string / nullifier string)
  // via the SAME shared loop the SW-inline (flag-off) path runs, so only the plain JSON
  // DTO array crosses. A not-found / un-reducible note is skipped inside the loop.
  getSerializedInputNoteDetails: async (client, noteIds: string[]) => {
    const details = await collectInputNoteDetails(noteId => client.getInputNote(noteId), noteIds);
    return new TextEncoder().encode(JSON.stringify(details));
  },

  // Import serialized note bytes into THIS (offscreen) client's store — a store
  // WRITE so the offscreen realm (which syncs + consumes) can see the note. Ships the
  // imported note id / details-commitment string back as UTF-8 bytes.
  importNoteBytes: async (client, noteBytes: Uint8Array) => {
    const id = await client.importNoteBytes(noteBytes);
    return new TextEncoder().encode(id);
  },

  // Pending-note recovery chunks (guardian seed recovery). Each is a short op
  // so the SW can interleave syncs/reads between chunks and report progress.
  drainPrivateNoteTransport: async client => {
    await client.drainPrivateNoteTransport();
    return null;
  },

  importRecoveryNoteBytes: async (client, encodedProposalNotes: string[]) => {
    const result = await client.importRecoveryNoteBytes(encodedProposalNotes.map(b64ToBytes));
    return new TextEncoder().encode(JSON.stringify(result));
  },

  resolveRecoveryScanRange: async (client, createdAtSeconds: number) => {
    const result = await client.resolveRecoveryScanRange(createdAtSeconds);
    return new TextEncoder().encode(JSON.stringify(result));
  },

  recoverPublicNotesRange: async (
    client,
    accountId: string,
    blockFrom: number,
    blockTo: number,
    noteOffset?: number
  ) => {
    const result = await client.recoverPublicNotesRange(accountId, blockFrom, blockTo, noteOffset ?? 0);
    return new TextEncoder().encode(JSON.stringify(result));
  },

  // Relay a just-created PRIVATE note to the transport layer (issue #260, slice 7b).
  // Under the flag the send ran here, so the note is an APPLIED OUTPUT note of THIS
  // (offscreen) client's store — which is what makes the relay belong here: under
  // 0.16 `sendPrivateNote` calls `notes.sendPrivateOutput({ noteId })`, which
  // resolves the note by id from the calling client's store and derives the
  // recipient's forward-scan hint from its stored `expected_height` (the chain tip
  // when the note's transaction was submitted). On the dormant SW client that
  // lookup simply fails. The live `Note` can't cross postMessage, so it arrived as
  // `Note.serialize()` raw bytes and is re-hydrated here purely to read its id back.
  // A transport relay — no prove / sign — so a void result (nothing to
  // re-hydrate); the SW-side caller only awaits it.
  sendPrivateNote: async (client, noteBytes: Uint8Array, to: string) => {
    const note = (sdk as any).Note.deserialize(noteBytes);
    await client.sendPrivateNote(note, to);
    return null;
  },

  // Re-push of an already-relayed private note, by id (see `relayPrivateNoteById`).
  // Belongs here for the same reason as `sendPrivateNote`: the output note lives in
  // THIS realm's store, so the id lookup and the `expected_height` hint derivation
  // only resolve here. No note bytes to carry — the sweep has only the row.
  relayPrivateNoteById: async (client, noteId: string, to: string) => {
    await client.relayPrivateNoteById(noteId, to);
    return null;
  },

  // Delivery receipt read for the sweep. Same store-ownership argument; returns the
  // boolean as UTF-8 bytes because the op channel carries bytes, not values.
  isOutputNoteConsumed: async (client, noteId: string) => {
    const consumed = await client.isOutputNoteConsumed(noteId);
    return new TextEncoder().encode(consumed ? 'true' : 'false');
  },

  // The first WRITE moved offscreen (issue #260, slice 5a). The WHOLE
  // execute→prove→submit→apply chain runs here in-realm as one op, so a wedge
  // anywhere in it is killable via `closeDocument()`. `client.consumeNoteId`
  // takes the SDK BUNDLED prove path (NOT OFFSCREEN_PROVE) because inside this
  // doc `isOffscreenAvailable()` is false — the `isInOffscreenDocument()`
  // recursion guard (offscreen-prover.ts, keyed off the `__MIDEN_IN_OFFSCREEN_DOC__`
  // marker set at this module's top) short-circuits it — so
  // `shouldUseOffscreenProver()` returns false and the prove runs on THIS doc's
  // pooled main-thread WASM instance (the client was created `useWorker:false`,
  // design §5.1/§5.2). The mid-execute signature is fetched from the SW via the
  // reverse-IPC stub. Only the final serialized `TransactionResult` crosses back;
  // the intermediate handles stay opaque in-realm (design §6.2).
  consumeNoteId: async (
    client,
    dto: { accountId: string; noteId: string; noteIds: string[]; delegateTransaction?: boolean }
  ) => {
    const result = await client.consumeNoteId(dto as unknown as ConsumeTransaction);
    return result.serialize() as Uint8Array;
  },

  // The remaining non-guardian WRITES moved offscreen (issue #260, slice 5b),
  // each mirroring `consumeNoteId` exactly: the whole execute→prove→submit→apply
  // chain runs here in-realm as one killable op, taking the SDK BUNDLED prove path
  // (NOT OFFSCREEN_PROVE — `isOffscreenAvailable()` is false inside this doc via the
  // `isInOffscreenDocument()` recursion guard), with
  // the mid-execute signature fetched from the SW via the reverse-IPC stub. Only
  // the final serialized `TransactionResult` crosses back. The BigInt amounts that
  // crossed as decimal strings are re-widened to BigInt so the reconstructed row
  // matches exactly what `MidenClientInterface` reads on the SW-inline (flag-off)
  // path.
  sendTransaction: async (
    client,
    dto: {
      accountId: string;
      secondaryAccountId: string;
      faucetId: string;
      noteType: unknown;
      amount: string;
      delegateTransaction?: boolean;
      extraInputs: { recallBlocks?: number };
    }
  ) => {
    // Bound to THIS op before any await, so a stamp fired late (an evicted
    // dispatch still running) carries its own op_id rather than the successor's
    // — see `postStageEvent` (issue #775).
    const context = dispatchContext();
    const tx = { ...dto, amount: BigInt(dto.amount) } as unknown as SendTransaction;
    // The per-step stage stamps (PR #524) are the ONE piece of this write the
    // caller still needs mid-flight, so they reverse to the SW as they happen
    // rather than riding the final result. `MidenClientInterface.sendTransaction`
    // drives execute → prove → submit as distinct stages and invokes `onStage` on
    // BOTH of its prover branches — the in-realm staged pipeline and the
    // offscreen-prover one (`proveLocallyViaOffscreen`) — so the stamps do not
    // depend on which branch runs here. Which one that is: inside this doc
    // `isOffscreenAvailable()` is false (the `isInOffscreenDocument()` recursion
    // guard), so `shouldUseOffscreenProver()` returns false and the prove runs on
    // THIS doc's pooled WASM; that choice moves the prove, not the stamping.
    const result = await client.sendTransaction(tx, stage => postStageEvent(context, stage));
    return result.serialize() as Uint8Array;
  },

  swapTransaction: async (
    client,
    dto: {
      accountId: string;
      faucetId: string;
      amount: string;
      delegateTransaction?: boolean;
      extraInputs: { requestedFaucetId: string; requestedAmount: string };
    }
  ) => {
    const tx = {
      ...dto,
      amount: BigInt(dto.amount),
      extraInputs: {
        requestedFaucetId: dto.extraInputs.requestedFaucetId,
        requestedAmount: BigInt(dto.extraInputs.requestedAmount)
      }
    } as unknown as SwapTransaction;
    const result = await client.swapTransaction(tx);
    return result.serialize() as Uint8Array;
  },

  // Positional args (accountId, requestBytes, delegateTransaction) mirroring the
  // SDK signature — `requestBytes` crossed as raw bytes, not JSON. `?? undefined`
  // maps a JSON-`null` delegate arg (an `undefined` round-tripped through
  // encodeArg) back to the SDK's optional-boolean shape.
  newTransaction: async (client, accountId: string, requestBytes: Uint8Array, delegateTransaction?: boolean) => {
    const result = await client.newTransaction(accountId, requestBytes, delegateTransaction ?? undefined);
    return result.serialize() as Uint8Array;
  },

  // The GUARDIAN write LEAF PIPELINE moved offscreen (issue #260, slice 6a). A
  // guardian tx's co-signature is contributed BEFORE execute, so `trBytes` is the
  // serialized, fully-signed, guardian-co-signed `TransactionRequest` (its
  // extended advice map — carrying the co-signatures — survives
  // `TransactionRequest.serialize()`; §4.0). We deserialize it and run the SAME
  // leaf as the SW-inline path — execute→prove→submit→apply — driving the RAW
  // client transactions API directly (`client.client.transactions.executeRequest`),
  // not a bundled `MidenClientInterface` write method, because the request is
  // pre-built. The mid-execute keystore signature is fetched from the SW via the
  // reverse-IPC stub. Only the final serialized `TransactionResult` crosses back.
  //
  // Prover selection replicates the inline block EXACTLY, minus one branch: the
  // mobile `newCallbackProver` case is OMITTED because the offscreen document is
  // extension-only (no chrome.offscreen in mobile WebViews; mobile stays flag-off
  // inline), so that branch is unreachable here — non-delegated proves with the
  // pooled main-thread WASM `newLocalProver`, delegated proves remote (`prove({})`)
  // with a local fallback on remote failure, identical to the SW path on extension.
  //
  // The three `postStageEvent` calls replicate `runGuardianPipeline`'s
  // `setStage('executing'|'proving'|'submitting')` at the SAME boundaries, so a
  // guardian send times its steps identically whichever realm ran the leaf. Unlike
  // the send dispatch — where the stamps come out of the SDK's own `onStage` hook —
  // this pipeline drives the raw transactions API itself, so it stamps the
  // boundaries itself too. Fire-and-forget (see `postStageEvent`): a lost stamp
  // costs a blank duration, never the transaction.
  guardianPipeline: async (client, accountId: string, trBytes: Uint8Array, delegateTransaction?: boolean) => {
    // This op's own id and lock hold, taken before any await so both are
    // provably ours (issue #775). The hold is what keeps a pause from silencing
    // the watchdog of whichever holder took the lock after an eviction; the id
    // is what keeps a late 'submitting' stamp off the successor's row.
    const context = dispatchContext();
    const { hold } = context;
    recordProveTiming(`guardianPipeline entered delegateTransaction=${delegateTransaction}`);
    const tr = (sdk as any).TransactionRequest.deserialize(trBytes);
    postStageEvent(context, 'executing');
    recordProveTiming('guardianPipeline calling executeRequest');
    const executedTx = await client.client.transactions.executeRequest(accountId, tr);
    recordProveTiming('guardianPipeline executeRequest returned; proving');
    postStageEvent(context, 'proving');
    let provenTx;
    if (!delegateTransaction) {
      recordProveTiming('guardianPipeline proving with local prover');
      // Local proving is deliberately unbounded — pause this realm's lock
      // watchdog for its duration, like proveWithFallback's local attempts
      // (#775). The delegated attempt stays on the clock.
      provenTx = await withWasmLockWatchdogPaused(
        () => executedTx.prove({ prover: (sdk as any).TransactionProver.newLocalProver() }),
        hold
      );
    } else {
      try {
        // Explicit remote prover rather than `prove({})`, and BOUNDED — the same fix
        // the inline `runGuardianPipeline` (transaction/index.ts) and
        // `MidenClientInterface.newTransaction` already carry. It was missed here, and
        // here is the copy that actually runs on Chrome: the service-worker bundle
        // DEFAULTS `MIDEN_USE_OFFSCREEN_CLIENT` to 'true', so a guardian write takes
        // `dispatchGuardianPipeline` into this realm and the fixed inline pipeline is
        // dead code on the shipping path. Two independent failures rode on that:
        //   1. The empty `prove({})` selects the SDK's DEFAULT-PROVER FALLBACK, which
        //      requires an initialized client and so never dispatches from a
        //      prover-only realm — the remote prover logs no request at all and the
        //      await never settles (#718).
        //   2. There was no client-side ceiling, unlike both fixed call sites, so
        //      nothing could convert that silence into the rejection the local
        //      fallback below needs. The write simply held the offscreen WASM mutex
        //      until the SW's write deadline killed the whole document.
        // Safe to bound here in the strongest sense available, exactly as inline: this
        // pipeline drives execute/prove/submit itself, so the deadline provably
        // expires BEFORE any submit and the local re-prove cannot broadcast twice.
        const delegatedProver = remoteProver();
        recordProveTiming(`guardianPipeline delegated prove, remoteProver=${delegatedProver ? 'set' : 'unavailable'}`);
        provenTx = await withDelegatedProveTimeout(
          executedTx.prove(delegatedProver ? { prover: delegatedProver } : {}),
          'Delegated guardian prove'
        );
      } catch (proveError) {
        console.warn(`${TAG} delegated guardian prove failed; retrying with local prover`, proveError);
        recordProveTiming(`guardianPipeline delegated prove FAILED (${String(proveError)}); re-proving locally`);
        provenTx = await withWasmLockWatchdogPaused(
          () => executedTx.prove({ prover: (sdk as any).TransactionProver.newLocalProver() }),
          hold
        );
      }
    }
    recordProveTiming('guardianPipeline prove returned; submitting');
    postStageEvent(context, 'submitting');
    const submittedTx = await provenTx.submit();
    recordProveTiming('guardianPipeline submit returned; applying');
    await submittedTx.apply();
    recordProveTiming('guardianPipeline apply returned');
    return executedTx.result.serialize() as Uint8Array;
  },

  // Post-pipeline commit-wait for the STRUCTURAL guardian completions (issue #260,
  // slice 6b — switch-guardian / replace-hot-key / update-procedure-threshold). It
  // MUST poll the SAME client that applied the tx: under the flag the whole leaf
  // ran here in the offscreen realm, so the SW client is dormant/unsynced and would
  // never see the committed record (it would time out at ~60s, fall through the
  // guardian catch to Failed, and SKIP the structural completion — leaving e.g.
  // replace-hot-key's on-chain rotation done but the local hot-key pointer stale).
  // Running the wait HERE polls the realm that owns the applied state.
  //
  // We DRIVE the poll loop in-realm (rather than calling the SDK's own
  // `transactions.waitFor`, which `MidenClientInterface.waitForTransactionCommit`
  // wraps) so we can YIELD the offscreen WASM mutex during the WASM-free inter-poll
  // sleep (issue #260 follow-up #1). Under `handleCall`'s `withWasmClientLock`, the
  // SDK's own waitFor would hold the single offscreen mutex for the ENTIRE ~60s poll
  // even though ~55s of it is pure `setTimeout` sleeps touching no WASM — blocking
  // balance polls, reads, and queued writes the whole time. This loop reproduces the
  // SDK `waitFor` semantics EXACTLY (chain-only sync → filter by id → committed
  // returns / discarded throws / timeout throws; SDK ref
  // `dist/mt/index.js` `TransactionsResource.waitFor`) but releases the mutex ONLY
  // around the sleep, where no WASM call is in flight (each `syncChain` /
  // `transactions.list` fully returns before the sleep, so the RefCell borrow is
  // clean at the yield boundary). A void result: the SW-side caller only awaits it,
  // so nothing serializes back.
  waitForTransactionCommit: async (client, transactionId: string) => {
    // Capture THIS op's reassert BEFORE the first yield (follow-up #2). While a
    // sleep yields the mutex, an interloper op runs and clears/overwrites the module
    // global `currentOpId`; re-asserting after each yield restores the invariant that
    // the sign stub reads this op's id. Local capture makes it immune to the
    // interloper also overwriting `reassertCurrentOpId`.
    const reassertOpId = reassertCurrentOpId;
    // This op's own lock hold, taken before the first yield so it is provably
    // ours (issue #775). Without it, a yield performed after this op had been
    // evicted would release whichever holder owns the mutex NOW — popping a
    // waiter into a concurrent WASM call alongside that live holder, then
    // leaving the mutex owned by nobody when this loop reacquired. The loop is
    // not cancelled by the eviction, so it would do that on every poll.
    const context = dispatchContext();
    const { hold } = context;
    const timeout = 60_000;
    const interval = 5_000;
    const start = Date.now();
    for (;;) {
      if (Date.now() - start >= timeout) {
        throw new Error(`Transaction confirmation timed out after ${timeout}ms`);
      }
      try {
        // Chain-only sync (matches the SDK): confirmation needs on-chain state only,
        // and skipping NTL keeps polling alive when note transport is unavailable.
        await client.client.syncChain();
      } catch {
        /* transient sync failure — keep polling, exactly as the SDK waitFor does */
      }
      const txs = await client.client.transactions.list({ ids: [transactionId] });
      const status = txs?.[0]?.transactionStatus?.();
      if (status?.isCommitted()) return null;
      if (status?.isDiscarded()) {
        throw new Error(`Transaction rejected: ${transactionId}`);
      }
      // Release the offscreen WASM mutex for the WASM-free inter-poll sleep only, so
      // other ops run during it; `yieldWasmClientLock` reacquires before we resume.
      await yieldWasmClientLock(() => new Promise(resolve => setTimeout(resolve, interval)), hold);
      // An interloper op that ran during the sleep cleared `currentOpId`; restore
      // it — but only while this flow still OWNS the lock. Eviction rejects the
      // SW-side caller without stopping this loop, so a corpse keeps polling for
      // up to a minute, and its yield no longer touches the mutex (the hold is
      // stale), so it resumes here with a successor genuinely holding. Stamping
      // its dead id back would route that successor's reverse-IPC sign to the
      // wrong op — pausing a write deadline that is not the signing op's, and
      // letting a corpse's sign failure land a `locked` reason in the successor's
      // slot. Comparing the captured hold against the current one is the only
      // question that distinguishes the two; `context.settled` cannot, because an
      // evicted dispatch has NOT settled — that is what makes it a corpse.
      if (getCurrentWasmLockHold() === context.hold) reassertOpId();
    }
  }
};

// The offscreen-owned client singleton, created lazily on first OFFSCREEN_CALL.
let clientPromise: Promise<MidenClientInterface> | null = null;

/**
 * Drop this realm's client when lock recovery declares it poisoned (issue #775).
 *
 * Recovery's own `replaceClientSingletons()` reaches only `midenClientSingleton`,
 * and this document deliberately does NOT use it — the client here is built with
 * `signCallback` + `useWorker:false` and cached in `clientPromise` above. Without
 * this hook recovery would release the mutex and then hand the next
 * OFFSCREEN_CALL the very client that just trapped, so the freeze would clear
 * and every following op would fail instead. That matters most in this realm,
 * because this is where the writes and proves run.
 *
 * Clearing the slot is all that is needed to keep future callers off it —
 * deliberately no `free()`, for the reason `reloadEndpointOverrides` documents
 * below: a dispatch that yielded the mutex resumes on its captured reference,
 * and terminating under it would fail an op that may still be healthy. The
 * displaced client goes with the realm when the document closes.
 *
 * It is however MARKED poisoned, which is not the same thing. The client's own
 * corpse guards key off that flag: `yieldLockUnlessDisposed` (so an evicted
 * dispatch cannot release the successor's mutex) and the keystore sign wrapper
 * (so an evicted dispatch reaching a sign cannot pause the successor's
 * watchdog). Those guards are the reason an eviction in this realm is
 * survivable, and dropping the reference alone would leave them switched off
 * for exactly the flows that were in flight — the ones that need them.
 *
 * The prove-only client goes too: `OFFSCREEN_PROVE` runs on its own raw
 * `WebClient` in this same WASM instance, so a trap that aborts the module
 * aborts that one as well, and it is memoized with no other reset path.
 */
onWasmClientPoisoned(() => {
  const poisoned = clientPromise;
  const hadProver = prover !== null;
  prover = null;
  clientPromise = null;
  // Synchronous, unlike `markPoisoned` below: the sign closure is created with
  // the client (not resolved from it), so the guard is armed before control ever
  // returns to an abandoned dispatch.
  if (currentSignLiveness) currentSignLiveness.poisoned = true;
  currentSignLiveness = null;
  if (!poisoned && !hadProver) return;
  console.warn(`${TAG} WASM client poisoned — dropping this realm's client so the next call rebuilds`);
  // Marking needs the resolved instance, so it lands a microtask later than the
  // synchronous drop above. A create still in flight resolves to a client built
  // on the poisoned module, which is equally untrustworthy; a rejected one has
  // nothing to mark.
  void poisoned?.then(client => client.markPoisoned()).catch(() => {});
});
function getOrCreateClient(): Promise<MidenClientInterface> {
  if (!clientPromise) {
    // Created with two Slice-5 overrides vs. the SW's plain singleton:
    //   - `signCallback: offscreenSignViaSW` — the reverse-IPC keystore stub, so
    //     a write op's mid-execute signing reaches the SW-resident vault (§2).
    //   - `useWorker: false` — REQUIRED (design §5.2). With the SDK worker shim
    //     (`useWorker:true`, the browser default) the client would run every
    //     method — including the write's local prove — in a method-worker with
    //     its own UN-pooled WASM instance, so proving would be single-threaded
    //     and the keystore callback would live in the worker (SDK: `lastAuthError`
    //     "meaningful only with useWorker:false"). `false` pins the client to
    //     THIS doc's main-thread WASM instance, whose rayon pool `init()` brought
    //     up — so reads AND the write's prove run multi-threaded and the sign
    //     callback is reachable.
    // The endpoint override is awaited HERE, not only in `init()`: `create` reads
    // `getEffectiveRpcUrl()` / `getEffectiveProverUrl()` / `getEffectiveNoteTransportUrl()`
    // and bakes them into the client for its whole lifetime, so the load has to be
    // ordered ahead of it at the creation site rather than at a distant caller. It is
    // the SAME memoized load `init()` already awaited (one storage read), except
    // after a reload — where it is the NEW load, which is precisely what makes the
    // rebuilt client pick the new endpoints up.
    // S1: null the cached promise if the create rejects (e.g. a transient RPC
    // genesis fetch failure) so the NEXT OFFSCREEN_CALL retries within this same
    // doc — otherwise a one-off failure would stick until the next kill/reopen.
    // Guarded on identity so a late rejection can only clear ITS OWN slot: a reload
    // that lands while this create is in flight already replaced the slot, and
    // blindly nulling would discard that healthy successor too.
    // One liveness token per created client, so poisoning can switch off THIS
    // client's sign without touching a successor's (issue #775).
    const liveness: SignLiveness = { poisoned: false };
    currentSignLiveness = liveness;
    const startedGeneration = wasmClientGeneration();
    recordProveTiming('getOrCreateClient: creating the offscreen client');
    const created: Promise<MidenClientInterface> = ensureEndpointOverrides()
      .then(() =>
        MidenClientInterface.create({
          signCallback: makeOffscreenSignViaSW(liveness),
          useWorker: false
        })
      )
      .then(client => {
        recordProveTiming('getOrCreateClient: client created');
        // A poisoning that lands while this create is in flight nulls the memo
        // synchronously, but a dispatch already awaiting THIS promise is ahead
        // of the poison hook's own `.then(markPoisoned)` in the microtask queue
        // — it would receive a live, unmarked client built on the poisoned
        // module, and its disposed-keyed guards (`yieldLockUnlessDisposed`, the
        // sign/prove pauses) would all read "healthy". Mark BEFORE resolving,
        // keyed on the cross-module generation both replace paths bump, so no
        // awaiter can ever observe the client unmarked (issue #775).
        if (wasmClientGeneration() !== startedGeneration) {
          client.markPoisoned();
        }
        return client;
      })
      .catch((err: unknown) => {
        if (clientPromise === created) clientPromise = null;
        throw err;
      });
    clientPromise = created;
  }
  return clientPromise;
}

/**
 * Re-read the saved developer endpoint override and drop the client singleton, so
 * the NEXT `getOrCreateClient()` rebuilds against the new endpoints. Driven by the
 * SW's `OFFSCREEN_RELOAD_ENDPOINTS` control message when the user saves a new
 * override — the SW's own `resetMidenClient()` reaches only the SW realm.
 *
 * It deliberately touches NOTHING in flight, which is what makes it safe to run at
 * any moment, including mid-write:
 *   - it runs no WASM call and takes no WASM mutex, so it neither queues behind a
 *     running op nor interrupts one;
 *   - `handleCall` captures its client in a LOCAL before dispatching, so clearing
 *     the module slot leaves a running op on the client it already holds. That op
 *     finishes against the endpoints it was created with, which is the only coherent
 *     outcome — its transaction was built for that node.
 * For the same reason the displaced client is NOT `free()`d: a dispatch that yields
 * the WASM mutex (the commit-wait, during its inter-poll sleeps) resumes on its
 * captured reference, and freeing the underlying WASM client under it would fail
 * that op. The displaced client is released with the rest of the realm when the
 * document closes.
 */
function reloadEndpointOverrides(): Promise<void> {
  const load = loadEndpointOverrides();
  // Both assignments before any await, so a `getOrCreateClient()` that interleaves
  // sees the cleared slot AND the fresh load — never one without the other. The memo
  // takes the never-rejecting shadow (see `ensureEndpointOverrides`) while the RAW
  // load is what's returned, so the caller can still report a failed reload.
  endpointOverridesPromise = load.catch(() => {});
  clientPromise = null;
  return load;
}

async function handleCall(msg: OffscreenCallRequest, sendResponse: (r?: unknown) => void): Promise<void> {
  const t = performance.now();
  // Envelope markers (#718). Everything between here and the dispatch can block
  // without any existing signal reaching the harness: `ensureInit` hydrates WASM and
  // brings up the rayon pool, `getOrCreateClient` performs the client's eager RPC
  // genesis fetch, and `withWasmClientLock` can queue behind another op for as long
  // as that op runs. Naming each boundary is what separates "the write is stuck in
  // the SDK" from "the write never started" — the SW-side deadline cannot tell them
  // apart, because a write's real deadline is armed at execution START and its
  // dispatch-time backstop is a flat 5 minutes either way.
  recordProveTiming(`call '${msg?.method}' op=${msg?.op_id} entered`);
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
    // NOTE: the client is deliberately NOT resolved here — it is resolved inside
    // the lock below, at execution start (issue #775).
    recordProveTiming(`call '${msg.method}' init ready; awaiting WASM mutex`);
    const args = msg.argsB64.map(decodeArg);
    // W1: serialize actual WASM entry inside THIS doc's own mutex (design §5,
    // §8-risk-5). The offscreen realm has its own module-level `wasmClientMutex`
    // (imported here in the offscreen bundle — distinct from the SW's instance),
    // so two concurrent OFFSCREEN_CALLs can't double-borrow the WASM client's
    // RefCell ("recursive use of an object" crash). The IPC layer already
    // supports >1 in-flight op; this is where they queue. Slice 4's concurrent
    // routes inherit this serialization for free.
    const resultBytes = await withWasmClientLock(async hold => {
      // Resolved INSIDE the lock, deliberately. Reading the slot before queueing
      // would pin this op to the client that was current when it arrived — and
      // the ops most likely to be queued are the ones waiting behind the holder
      // that just trapped, so every one of them would run on the poisoned client
      // the poison hook had already dropped (issue #775). Same reasoning as the
      // ambient op_id below: what matters is the state at EXECUTION start.
      recordProveTiming(`call '${msg.method}' won WASM mutex; getting client`);
      const client = await getOrCreateClient();
      // Stash the ambient op_id for the duration of the WASM op so the reverse-IPC
      // sign stub (invoked mid-execute) can tag its request with this op (design
      // §2.4). Scoped tightly to the locked section: the mutex serializes ops, so
      // exactly one op's id is live at a time — EXCEPT while a mutex-yielding dispatch
      // (the commit-wait, follow-up #1) sleeps, which is why it re-asserts via the
      // per-op closure below (follow-up #2). No `await` separates these two
      // assignments, so the closure is always bound to the same op as `currentOpId`.
      currentOpId = msg.op_id;
      reassertCurrentOpId = () => {
        currentOpId = msg.op_id;
      };
      // Now that this op has WON the WASM mutex and is about to execute, tell the
      // SW to arm its write deadline at EXECUTION START (issue #260 flip-prep #3).
      // Fire-and-forget: queue-wait behind other ops was off-budget; the clock
      // starts here. Sent from inside the lock so it fires exactly once per op,
      // only for a real dispatch (unknown-method / init-failure paths never reach
      // here). `Promise.resolve(...)` tolerates a mock sendMessage that returns a
      // non-promise; the response is intentionally ignored.
      const started: OffscreenOpStarted = { target: SW_TARGET, type: OFFSCREEN_OP_STARTED, op_id: msg.op_id };
      void Promise.resolve(chrome.runtime.sendMessage(started)).catch(() => {});
      recordProveTiming(`call '${msg.method}' client ready; dispatching`);
      // Published for the dispatch to take in its first statement — the only
      // point at which "the op that owns this hold" is knowable (issue #775).
      // No await between here and the call, so what it takes is provably ours.
      const context: DispatchContext = { op_id: msg.op_id, hold, settled: false };
      startingDispatch = context;
      try {
        return await dispatch(client, ...args);
      } finally {
        // Closes the window for late stage stamps: whatever the dispatch does
        // after this point, its stamps are about a step the SW has already been
        // told the outcome of (see `postStageEvent`).
        context.settled = true;
        // Only if it is still OURS. An evicted dispatch keeps running and can
        // settle long after a successor installed its own id; clearing blindly
        // would leave the healthy successor with no ambient id, so its
        // mid-execute sign would fail on the no-ambient-id guard (issue #775).
        if (currentOpId === msg.op_id) currentOpId = null;
        recordProveTiming(`call '${msg.method}' dispatch settled; releasing WASM mutex`);
      }
    });
    sendResponse({
      ok: true,
      op_id: msg.op_id,
      resultB64: resultBytes ? bytesToB64(resultBytes) : null,
      durationMs: performance.now() - t
    });
  } catch (err) {
    console.error(`${TAG} call '${msg?.method}' failed:`, err);
    // Telemetry must survive a hostile thrown value whose every getter throws
    // (the same reason the error extraction below is guarded) — a crash here
    // would swallow the SW's error response entirely.
    let failDetail = 'unreadable error';
    try {
      failDetail = String((err as { message?: string })?.message ?? err);
    } catch {
      /* keep the placeholder */
    }
    recordProveTiming(`call '${msg?.method}' FAILED ${failDetail}`);
    // A lock-recovery eviction rejects the WAITER while the dispatch runs on, so
    // the `finally` that clears the ambient id never ran and this op's id is
    // still installed (issue #775). The next op overwrites it with its own, and
    // the abandoned dispatch's sign would then be tagged with the SUCCESSOR's
    // op_id — pausing that op's write deadline, and letting a corpse's sign
    // failure write a `locked` reason into the successor's slot, which the SW
    // re-tags onto the successor's own error. Clear it while it is still
    // provably ours; a corpse sign then fails loudly on the no-ambient-id guard.
    if (currentOpId === msg?.op_id) {
      currentOpId = null;
      reassertCurrentOpId = () => {};
    }
    // Preserve the SDK's stable error code when it sets one (issue #260,
    // funds-critical). The offscreen client runs `useWorker:false`, so a failed
    // write throws the RAW main-thread JsError — extract the code with the SAME
    // helper the SW-inline classifier uses. web-sdk 0.16 leaves most failures
    // code-less, so the funds-critical apply-after-submit case is carried by the
    // `error` TEXT below instead and re-classified SW-side by
    // `isApplyAfterSubmitError`; forwarding the message verbatim is what makes the
    // round trip classify identically to flag-off (marked Completed, NOT Failed →
    // requeue → double-spend). `undefined` for a code-less error keeps the reply
    // shape unchanged (mirrors the flag-off path).
    const errorName = errorNameOf(err);
    // Guarded for the same reason `errorName` is: both reads touch a value of
    // unknown provenance, and `message` can be an accessor that throws just as
    // `name` can. A throw escaping here skips `sendResponse` entirely, which the
    // SW cannot distinguish from a wedged realm — it waits out the per-op
    // deadline and closes the document rather than getting the failure it is
    // owed. A placeholder string is worth strictly more than that.
    let error = 'offscreen call failed (error details unreadable)';
    let errorCode: string | undefined;
    try {
      error = String((err as { message?: string })?.message ?? err);
      errorCode = extractSdkErrorCode(err);
    } catch {
      /* unreadable error object — the reply below still carries the class */
    }
    sendResponse({
      ok: false,
      op_id: msg?.op_id,
      error,
      errorCode,
      // The error CLASS, for the classifications that key off it rather than off
      // a code — today `WasmClientPoisonedError` from this realm's own lock
      // recovery (issue #775). Without it the SW rebuilds a bare `Error` and
      // treats an abandoned-but-possibly-still-submitting op as an ordinary
      // failure.
      errorName,
      // Read off the ALREADY-GUARDED name rather than re-classifying `err`:
      // `isWasmClientPoisonedError` reads `.name` unguarded, and a foreign
      // object with a throwing accessor would escape this catch — leaving the
      // SW with no reply at all, waiting out its deadline instead of getting
      // the failure it is owed. `errorNameOf` exists for exactly that reason.
      errorReason: errorName === 'WasmClientPoisonedError' ? poisonReasonOf(err) : undefined
    });
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

  if (msg?.type === OFFSCREEN_RELOAD_ENDPOINTS) {
    (async () => {
      try {
        // NOT gated on `ensureInit()`, unlike the two families above: re-reading a
        // storage key and clearing a module slot need neither the WASM instance nor
        // the rayon pool, and waiting on a cold start would just delay the answer the
        // SW is holding the user's "Save" on.
        await reloadEndpointOverrides();
        const response: OffscreenReloadEndpointsResponse = { ok: true };
        sendResponse(response);
      } catch (err) {
        // `loadEndpointOverrides` swallows its own storage failures (falling back to
        // "no override"), so reaching here means something unexpected. Answer ok:false
        // rather than dropping the response, which would leave the SW's await hanging.
        console.error(`${TAG} endpoint-override reload failed:`, err);
        const response: OffscreenReloadEndpointsResponse = {
          ok: false,
          error: String((err as { message?: string })?.message ?? err)
        };
        sendResponse(response);
      }
    })();
    // Returning true tells Chrome we'll call sendResponse async.
    return true;
  }

  return false;
});

console.log(`${TAG} loaded`);
