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
  OFFSCREEN_OP_STARTED,
  OFFSCREEN_SIGN_REQUEST,
  OFFSCREEN_TELEMETRY_EVENT,
  SW_TARGET,
  b64ToBytes,
  bytesToB64,
  decodeArg,
  type OffscreenCallRequest,
  type OffscreenOpStarted,
  type OffscreenSignResponse
} from 'lib/miden/back/offscreen-codec';
import type { ConsumeTransaction, SendTransaction, SwapTransaction } from 'lib/miden/db/types';
import { collectInputNoteDetails } from 'lib/miden/sdk/input-note-detail';
import { reduceInputNoteSummary } from 'lib/miden/sdk/input-note-summary';
import { withWasmClientLock, yieldWasmClientLock } from 'lib/miden/sdk/miden-client';
import { MidenClientInterface } from 'lib/miden/sdk/miden-client-interface';
import { reducePswapLineage } from 'lib/miden/sdk/pswap-lineage';
import { extractSdkErrorCode } from 'lib/miden/sdk/sdk-error-code';
import { reportProve, setOperationTransport } from 'lib/telemetry/report-operation';

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

// Telemetry reported from THIS realm has to be forwarded, and nothing else would
// do it. `report-operation.ts` sends directly when it is the worker and uses an
// installed transport when it is a page; this document is neither. It has a
// `window`, so it takes the page branch, and it never loads the React app, so
// nothing installs a transport — every event would be dropped on the floor.
//
// That matters here specifically because proving happens in this realm whenever
// the offscreen client is on, which is the default for the extension. Without
// this, `prove_delegate`, `prove_local`, `prove_fallback` and the prover-outage
// events never leave the device: exactly the signals that answer "was the remote
// prover down when this failed".
setOperationTransport(async event => {
  await chrome.runtime.sendMessage({ target: SW_TARGET, type: OFFSCREEN_TELEMETRY_EVENT, event });
});

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

async function offscreenSignViaSW(publicKey: Uint8Array, signingInputs: Uint8Array): Promise<Uint8Array> {
  const op_id = currentOpId;
  if (!op_id) {
    // A sign fired outside an OFFSCREEN_CALL — should be impossible (signing only
    // happens inside a dispatched write op). Fail loud rather than sign untagged.
    throw new Error('offscreen sign: no ambient op_id (sign fired outside an OFFSCREEN_CALL)');
  }
  const sign_id = newSignId();
  const resp = (await chrome.runtime.sendMessage({
    target: SW_TARGET,
    type: OFFSCREEN_SIGN_REQUEST,
    op_id,
    sign_id,
    publicKeyB64: bytesToB64(publicKey),
    signingInputsB64: bytesToB64(signingInputs)
  })) as OffscreenSignResponse | undefined;
  if (!resp || !resp.ok) {
    // Throw so the SDK's WebKeyStore captures it (offscreen `lastAuthError`) and
    // the execute fails; the SW-side handler already recorded the classified
    // reason authoritatively for the locked-defer path (design §2.6).
    throw new Error(`offscreen sign failed: ${resp && !resp.ok ? resp.error : 'no response from SW'}`);
  }
  return b64ToBytes(resp.signatureB64);
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
  // Under the flag the send ran here, so the note lives in THIS (offscreen) client's
  // store and THIS realm owns the fresh sync height that `sendPrivateNote` attaches
  // as the recipient's forward-scan hint — so the relay MUST run here, not on the
  // dormant SW client (whose stale height would overshoot the note's commitment).
  // The live `Note` can't cross postMessage, so it arrived as `Note.serialize()` raw
  // bytes and is re-hydrated here; `notes.sendPrivate` uses the live Note DIRECTLY (no
  // store lookup — that path is only for note-ID inputs), so nothing else is read off
  // the store. A transport relay — no prove / sign — so a void result (nothing to
  // re-hydrate); the SW-side caller only awaits it.
  sendPrivateNote: async (client, noteBytes: Uint8Array, to: string) => {
    const note = (sdk as any).Note.deserialize(noteBytes);
    await client.sendPrivateNote(note, to);
    return null;
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
    const tx = { ...dto, amount: BigInt(dto.amount) } as unknown as SendTransaction;
    const result = await client.sendTransaction(tx);
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
  guardianPipeline: async (client, accountId: string, trBytes: Uint8Array, delegateTransaction?: boolean) => {
    const tr = (sdk as any).TransactionRequest.deserialize(trBytes);
    const executedTx = await client.client.transactions.executeRequest(accountId, tr);
    let provenTx;
    // Reported from here as well as from the two inline copies, because on the
    // extension THIS is the copy that runs: every guardian leaf type is offscreen
    // routable and the flag defaults on, so instrumenting only the inline path
    // left guardian operations contributing nothing to prover health on the build
    // almost everyone uses.
    const proveStartedAt = performance.now();
    if (!delegateTransaction) {
      try {
        provenTx = await executedTx.prove({ prover: (sdk as any).TransactionProver.newLocalProver() });
        reportProve({ startedAt: proveStartedAt, step: 'prove_local' });
      } catch (proveError) {
        reportProve({ startedAt: proveStartedAt, step: 'prove_local', error: proveError });
        throw proveError;
      }
    } else {
      try {
        provenTx = await executedTx.prove({});
        reportProve({ startedAt: proveStartedAt, step: 'prove_delegate' });
      } catch (proveError) {
        console.warn(`${TAG} delegated guardian prove failed; retrying with local prover`, proveError);
        try {
          provenTx = await executedTx.prove({ prover: (sdk as any).TransactionProver.newLocalProver() });
          reportProve({ startedAt: proveStartedAt, step: 'prove_fallback' });
        } catch (fallbackError) {
          reportProve({ startedAt: proveStartedAt, step: 'prove_fallback', error: fallbackError });
          throw fallbackError;
        }
      }
    }
    const submittedTx = await provenTx.submit();
    await submittedTx.apply();
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
      await yieldWasmClientLock(() => new Promise(resolve => setTimeout(resolve, interval)));
      // An interloper op that ran during the sleep cleared `currentOpId`; restore it.
      reassertOpId();
    }
  }
};

// The offscreen-owned client singleton, created lazily on first OFFSCREEN_CALL.
let clientPromise: Promise<MidenClientInterface> | null = null;
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
    // S1: null the cached promise if the create rejects (e.g. a transient RPC
    // genesis fetch failure) so the NEXT OFFSCREEN_CALL retries within this same
    // doc — otherwise a one-off failure would stick until the next kill/reopen.
    clientPromise = MidenClientInterface.create({
      signCallback: offscreenSignViaSW,
      useWorker: false
    }).catch((err: unknown) => {
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
    const resultBytes = await withWasmClientLock(async () => {
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
      try {
        return await dispatch(client, ...args);
      } finally {
        currentOpId = null;
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
    // Preserve the SDK's stable `errorCode` (issue #260, funds-critical). The
    // offscreen client runs `useWorker:false`, so a failed write throws the RAW
    // main-thread JsError still carrying `errorCode` — extract it with the SAME
    // helper the SW-inline classifier uses so a round-tripped
    // `ApplyTransactionAfterSubmitFailed` is classified identically to flag-off
    // (marked Completed, NOT Failed → requeue → double-spend). `undefined` for a
    // code-less error keeps the reply shape unchanged (mirrors the flag-off path).
    sendResponse({
      ok: false,
      op_id: msg?.op_id,
      error: String((err as { message?: string })?.message ?? err),
      errorCode: extractSdkErrorCode(err)
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

  return false;
});

console.log(`${TAG} loaded`);
