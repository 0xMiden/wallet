import { Runtime } from 'webextension-polyfill';

import { queueNoteImport } from 'lib/miden/activity';
import { isLikelyNetworkError } from 'lib/miden/activity/connectivity-classify';
import {
  CONNECTIVITY_CATEGORIES,
  applyConnectivityReport,
  hydrateConnectivityState,
  type ConnectivityCategory
} from 'lib/miden/activity/connectivity-state';
import * as Actions from 'lib/miden/back/actions';
import { intercom } from 'lib/miden/back/defaults';
import {
  handleOffscreenSignRequest,
  handleOffscreenStageEvent,
  markOpStarted,
  midenClientProxy,
  reloadOffscreenEndpointOverrides
} from 'lib/miden/back/miden-client-proxy';
import { isOperationAbortedError } from 'lib/miden/back/offscreen-codec';
import {
  OFFSCREEN_CONNECTIVITY_EVENT,
  OFFSCREEN_OP_STARTED,
  OFFSCREEN_PROVE_MARKER,
  OFFSCREEN_SIGN_REQUEST,
  OFFSCREEN_STAGE_EVENT,
  SW_TARGET,
  type OffscreenSignRequest
} from 'lib/miden/back/offscreen-codec';
import { getSpeculationManager, initSpeculationManager } from 'lib/miden/back/speculation-manager';
import { store, toFront } from 'lib/miden/back/store';
import { doSync, resetSyncBackoffForEndpointChange } from 'lib/miden/back/sync-manager';
import { startTransactionProcessing, swSignCallback } from 'lib/miden/back/transaction-processor';
import { clearSyncFuseForEndpointChange } from 'lib/miden/front/sync-fuse';
import { isWasmClientPoisonedError, WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';
import { loadEndpointOverrides } from 'lib/miden-chain/effective-endpoints';
import { primeNativeAssetId } from 'lib/miden-chain/native-asset';
import { WalletMessageType, WalletRequest, WalletResponse } from 'lib/shared/types';
import { logger } from 'shared/logger';

import { TRANSACTION_STAGES, type ITransactionStage } from '../db/types';
import { NoteExportType } from '../sdk/constants';
import {
  assertWasmHoldCurrent,
  getCurrentWasmLockHold,
  getMidenClient,
  resetMidenClient,
  withWasmClientLock
} from '../sdk/miden-client';
import { MidenMessageType } from '../types';

// frontStore is initialized lazily inside start() because with Vite's TLA stripping,
// `store` may not be initialized at module scope evaluation time.
let frontStore: ReturnType<typeof store.map> | null = null;

export async function start() {
  console.log('Miden background script started');
  intercom.onRequest(processRequest);
  registerOffscreenSignHandler();

  // The connectivity snapshot is in-memory and therefore empty on every MV3 wake,
  // but its storage mirror — the copy the popup actually renders — is durable. Seed
  // the snapshot FROM the mirror so the two agree: otherwise the mutators' "already
  // clear" short-circuit swallows the clear that would repair a stale mirrored issue
  // and the banner latches an outage that has already recovered.
  //
  // Hydrating rather than blanking the mirror, because the categories cannot be
  // re-established quickly. `node`/`network` need THREE more consecutive sync
  // failures (sync-manager's MAX_CONSECUTIVE_SYNC_FAILURES), each up to its 30s
  // watchdog and spaced by the circuit breaker's 30s–5min backoff — and that streak
  // counter is SW-module state this same wake resets to zero, against at most TWO
  // syncs per wake with the popup closed (setupSyncManager's initial one and the
  // alarm's, which `doSync` may even coalesce into one), so three is never reached.
  // `prover` is worse: nothing probes it, so a blanked prover banner returns only on
  // the user's next delegated prove, which may never come — while
  // `transaction/index.ts` requeues a guardian send on a prover outage and relies on
  // that banner to explain the wait. Blanking would also un-dismiss a banner the user
  // dismissed, via the `!merged[category].active` cleanup in `use-connectivity-state`.
  //
  // Runs AFTER `registerOffscreenSignHandler()` — which must stay synchronous with SW
  // start so an inbound message can't miss it — and hydration yields a category to any
  // observation that lands during its read, so an offscreen report arriving mid-load
  // wins over the pre-restart mirror.
  await hydrateConnectivityState();

  // NOTE: The Vite sw-patches plugin injects await init_*() calls here
  // (between intercom registration and Actions.init)

  // Apply any developer endpoint override before any client/vault init reads
  // endpoints. Must run before primeNativeAssetId() below — its cache keys
  // are derived from getEffectiveNetworkName() at call time.
  await loadEndpointOverrides();

  await Actions.init();

  // E2E-only (dead-stripped in prod): expose the swap taker discovery + fill in
  // the SW, where the vault signs SW-direct. Signer mirrors swSignCallback.
  if (process.env.MIDEN_E2E_TEST === 'true') {
    const { installSwapConsumeHooks } = await import('lib/miden/swap/test-hooks');
    installSwapConsumeHooks(async (pk, si) => {
      const sigHex = await Actions.signTransaction(Buffer.from(pk).toString('hex'), Buffer.from(si).toString('hex'));
      return new Uint8Array(Buffer.from(sigHex, 'hex'));
    });
    const { installBridgeInTestHooks } = await import('lib/miden/activity/bridge-in-test-hooks');
    installBridgeInTestHooks();
    const { installEarnTestHooks } = await import('lib/miden/activity/earn-test-hooks');
    installEarnTestHooks();
  }

  // SpeculationManager wires through the same MidenClientInterface singleton
  // the rest of the SW uses. Lazy because the client is only created on
  // unlock; the manager doesn't run anything until a SPECULATE_SEND_REQUEST
  // arrives, by which point the client must already exist (the user is on
  // the send-flow review screen, which is gated on unlock).
  //
  // Returns null — leaving `getSpeculationManager()` null and both SPECULATE
  // handlers below inert — when the send that would consume the speculation runs
  // in the offscreen realm instead of here. See `initSpeculationManager` for why
  // speculating anyway would be harmful rather than merely wasteful.
  initSpeculationManager(() => getMidenClient());

  // Native asset ID is network-wide on-chain state — prime discovery here so
  // the first balance / metadata consumer after SW start already has it cached.
  // Cheap (one RPC round-trip on cache miss, no-op on hit).
  primeNativeAssetId();

  frontStore = store.map(toFront);
  frontStore.watch(() => {
    intercom.broadcast({ type: WalletMessageType.StateUpdated });
  });
  // Force frontend to re-fetch state now that everything is initialized
  intercom.broadcast({ type: WalletMessageType.StateUpdated });
}

// Guard so a repeated start() (defensive) doesn't stack duplicate listeners.
let offscreenSignHandlerRegistered = false;

/**
 * The stage names as a runtime set, for validating a stamp that arrived over the
 * extension message bus.
 *
 * Built from {@link TRANSACTION_STAGES} — the tuple `ITransactionStage` is derived
 * from — so a stage added to the union is accepted here with no second edit and
 * cannot drift.
 */
const TRANSACTION_STAGE_NAMES: ReadonlySet<string> = new Set<string>(TRANSACTION_STAGES);

/**
 * Runtime membership test for an inbound stage stamp.
 *
 * The listener below types its message loosely, declaring `stage?: ITransactionStage`
 * — a claim about a value the compiler never saw, since it arrives off the message
 * bus. A bare `typeof m.stage === 'string'` therefore type-checks as a narrowing but
 * validates nothing: ANY string would be written to the transaction row as its stage,
 * where the generating-transaction screen reads it to pick the active step and (on a
 * Failed row) to pin the step that failed. Check the value, not just its type.
 */
const isTransactionStage = (value: unknown): value is ITransactionStage =>
  typeof value === 'string' && TRANSACTION_STAGE_NAMES.has(value);

/**
 * The connectivity categories as a runtime set, for validating a report that
 * arrived over the extension message bus. Built from the canonical
 * {@link CONNECTIVITY_CATEGORIES} list so a new category needs no second edit.
 */
const CONNECTIVITY_CATEGORY_NAMES: ReadonlySet<string> = new Set<string>(CONNECTIVITY_CATEGORIES);

/**
 * Runtime membership test for an inbound connectivity report — a VALUE check for
 * the same reason {@link isTransactionStage} is one: the message's declared type
 * is a claim about bytes the compiler never saw, and an unchecked string would be
 * written into the snapshot as a category the banner then has to render.
 */
const isConnectivityCategory = (value: unknown): value is ConnectivityCategory =>
  typeof value === 'string' && CONNECTIVITY_CATEGORY_NAMES.has(value);

/**
 * Register the SW-side reverse-IPC sign listener (issue #260, slice 5, design §2.4).
 *
 * When the flag-on offscreen write reaches its execute step, the offscreen
 * client's `keystore.sign` stub posts an `OFFSCREEN_SIGN_REQUEST` (targeted at
 * the SW). The SW signs via `swSignCallback` — the SAME vault signer the inline
 * path uses — and responds with raw signature bytes; the reverse-IPC handler
 * also pauses/re-arms the op's deadline and records a locked-mid-sign reason so
 * the consume DEFERS (issue #313). Only bytes cross; no SDK handle.
 *
 * This rides a raw `chrome.runtime.onMessage` listener (like the offscreen
 * prover's `OFFSCREEN_READY`), distinct from the intercom hub. The tight
 * `target === 'sw' && type === OFFSCREEN_SIGN_REQUEST` guard means every other
 * message (intercom traffic, `OFFSCREEN_READY`, `OFFSCREEN_CALL` responses)
 * falls straight through. No-op when `chrome.runtime.onMessage` is unavailable
 * (non-extension bundles), where the offscreen flag is hardcoded off anyway.
 */
/** Storage key holding the offscreen realm's `[prove-timing]` trail. Mirrors
 * `proveMarkerStorageKey('offscreen')` in `lib/miden/sdk/prove-telemetry`, and is
 * read by the E2E harness's prove-telemetry probe. */
const OFFSCREEN_PROVE_MARKER_KEY = 'miden_prove_markers_offscreen';
/** Bound matching the recording realm's own ring, so the key cannot grow without limit. */
const OFFSCREEN_PROVE_MARKER_CAPACITY = 200;

/** Serializes the read-append-write cycles so a burst of markers cannot have two
 * of them interleave and drop each other's additions. */
let proveMarkerQueue: Promise<void> = Promise.resolve();

/**
 * Append one offscreen marker to the SW-owned trail.
 *
 * Best-effort throughout — this is diagnostics arriving from the prove path, and it
 * must never be able to fail a write.
 */
function appendOffscreenProveMarker(ts: number, line: string): void {
  proveMarkerQueue = proveMarkerQueue
    .then(async () => {
      const local = chrome?.storage?.local;
      if (!local?.get || !local?.set) return;
      const raw = (await local.get(OFFSCREEN_PROVE_MARKER_KEY))?.[OFFSCREEN_PROVE_MARKER_KEY];
      const existing = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
      const next = [...existing, `${ts}|${line}`].slice(-OFFSCREEN_PROVE_MARKER_CAPACITY);
      await local.set({ [OFFSCREEN_PROVE_MARKER_KEY]: next });
    })
    .catch(() => {});
}

function registerOffscreenSignHandler(): void {
  if (offscreenSignHandlerRegistered) return;
  if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage?.addListener) return;
  offscreenSignHandlerRegistered = true;
  chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse: (r?: unknown) => void) => {
    // A SW-targeted message is an OFFSCREEN_SIGN_REQUEST, an OFFSCREEN_OP_STARTED,
    // an OFFSCREEN_STAGE_EVENT or an OFFSCREEN_CONNECTIVITY_EVENT (distinct `type`
    // literals), so type `m` loosely and discriminate on `type` below.
    const m = msg as
      | {
          target?: string;
          type?: string;
          op_id?: string;
          sign_id?: string;
          stage?: ITransactionStage;
          category?: ConnectivityCategory;
          active?: boolean;
          ts?: number;
          line?: string;
        }
      | undefined;
    if (m?.target !== SW_TARGET) return false;
    // Execution-start signal (issue #260 flip-prep #3): the op named by `op_id`
    // has won the offscreen WASM mutex and is about to execute — arm its write
    // deadline now. Fire-and-forget: no async response, so don't hold the port.
    if (m.type === OFFSCREEN_OP_STARTED) {
      if (typeof m.op_id === 'string') markOpStarted(m.op_id);
      return false;
    }
    // Per-step stage stamp (PR #524): the offscreen write named by `op_id` entered
    // `stage`. Forward it to that op's registered callback, which stamps the
    // transaction row so the generating-transaction screen can show a duration per
    // step. Fire-and-forget like the start signal — no response, so don't hold the
    // port; the handler itself swallows an unknown op and a throwing callback.
    // `isTransactionStage` is a VALUE check, not just a type check — see its doc.
    if (m.type === OFFSCREEN_STAGE_EVENT) {
      if (typeof m.op_id === 'string' && isTransactionStage(m.stage)) handleOffscreenStageEvent(m.op_id, m.stage);
      return false;
    }
    // Connectivity report from the offscreen realm. That realm executes the writes,
    // so it — not the SW — observes prover health, but the connectivity snapshot is
    // module-scoped and mirrors to ONE storage key, so it reports here instead of
    // writing that key itself (issue #260; see `setConnectivityReporter`). Applying
    // it ONE CATEGORY at a time keeps the SW the single writer, so the two realms'
    // observations accumulate per category rather than overwriting each other.
    // `applyConnectivityReport`, not the ordinary mark/clear: those short-circuit on
    // "already active / already clear" and so would skip the storage mirror, which
    // is exactly what a re-sent report after an SW eviction has to repair. See its
    // doc. Fire-and-forget like the two signals above — no response, port not held.
    // The category is a VALUE check (see `isConnectivityCategory`), and `active` must
    // be a real boolean: a missing field would otherwise read as "clear".
    if (m.type === OFFSCREEN_CONNECTIVITY_EVENT) {
      if (isConnectivityCategory(m.category) && typeof m.active === 'boolean') {
        applyConnectivityReport(m.category, m.active);
      }
      return false;
    }
    // E2E-only prove breadcrumb from the offscreen realm (#718). Same single-writer
    // reasoning as the connectivity report above, for the same reason: that realm has
    // no `chrome.storage`. Appending here is what makes a stalled write legible — the
    // last marker to arrive names the call the realm is still inside.
    if (m.type === OFFSCREEN_PROVE_MARKER) {
      if (typeof m.ts === 'number' && typeof m.line === 'string') appendOffscreenProveMarker(m.ts, m.line);
      return false;
    }
    if (m.type !== OFFSCREEN_SIGN_REQUEST) return false;
    handleOffscreenSignRequest(msg as OffscreenSignRequest, swSignCallback).then(sendResponse, (err: unknown) => {
      // The handler already classifies vault errors; a throw here is an
      // unexpected internal fault. Respond ok:false so the offscreen sign stub
      // rejects (failing the write) rather than hanging on a dropped response.
      sendResponse({
        ok: false,
        sign_id: m.sign_id ?? '',
        error: err instanceof Error ? err.message : String(err),
        reason: 'internal'
      });
    });
    // Returning true tells Chrome we'll call sendResponse asynchronously.
    return true;
  });
}

async function processRequest(req: WalletRequest, _port: Runtime.Port): Promise<WalletResponse | void> {
  switch (req?.type) {
    case WalletMessageType.SyncRequest:
      doSync(req.force).catch(err => console.warn('[SyncManager] Error:', err));
      return { type: WalletMessageType.SyncResponse };
    case WalletMessageType.NoteClaimStarted:
      intercom.broadcast({ type: WalletMessageType.NoteClaimStarted, noteId: req.noteId });
      return { type: WalletMessageType.NoteClaimStartedResponse };
    case WalletMessageType.ProcessTransactionsRequest:
      // Fire-and-forget — start processing asynchronously
      startTransactionProcessing().catch(err => console.error('[TransactionProcessor] Error:', err));
      return { type: WalletMessageType.ProcessTransactionsResponse };
    case WalletMessageType.ReloadEndpointOverridesRequest:
      // Re-hydrate the override cache in THIS (service-worker) realm, then invalidate
      // every client that baked the old endpoints in at creation time. All three steps
      // are needed because the override cache and the client singleton are BOTH
      // module-scoped, and module scope is per realm:
      //   - loadEndpointOverrides() refreshes the SW realm's cache
      //     (lib/miden-chain/effective-endpoints.ts).
      //   - resetMidenClient() disposes ONLY the SW realm's MidenClientInterface
      //     singleton, so the next SW-side getMidenClient() rebuilds on the new
      //     endpoints.
      //   - reloadOffscreenEndpointOverrides() does the equivalent inside the offscreen
      //     document, which flag-on (MIDEN_USE_OFFSCREEN_CLIENT, the service worker's
      //     default) owns the client that actually executes writes, syncs and talks to
      //     the node — resetMidenClient() cannot reach it. No-op when the flag is off,
      //     when chrome.offscreen is absent, or when no document is open.
      //   - resetSyncBackoffForEndpointChange() drops the breaker window and the
      //     watchdog-eviction fuse, both of which are findings about the OLD node. A
      //     fused SW otherwise syncs once per 30 min against the new one, which reads
      //     as "the repoint did nothing" and withholds the successful sync that is the
      //     fuse's only exit condition (#777).
      //   - clearSyncFuseForEndpointChange() drops the shared per-probe ledger, which
      //     this realm now writes to as well: the note-import pass runs in the service
      //     worker on the extension, so a fuse lit there would otherwise outlive the node
      //     it was earned against with nothing in this realm able to clear it.
      //   - primeNativeAssetId() rediscovers the native faucet and its base fee for the
      //     new node. The caches invalidate themselves lazily on the next read, but this
      //     realm's auto-consume decides what to claim from that fee, so leaving the
      //     rediscovery to whoever happens to ask next means the first sync after a
      //     repoint judges notes against the old chain's fee.
      await loadEndpointOverrides();
      resetSyncBackoffForEndpointChange();
      clearSyncFuseForEndpointChange();
      await resetMidenClient();
      primeNativeAssetId();
      await reloadOffscreenEndpointOverrides();
      return { type: WalletMessageType.ReloadEndpointOverridesResponse };
    case WalletMessageType.ImportNoteBytesRequest: {
      const noteBytes = new Uint8Array(Buffer.from(req.noteBytes, 'base64'));
      // Byte-identical twin of the `importAllNotes` site slice 7a already routed:
      // under the flag the note MUST land in the OFFSCREEN store (the realm that
      // syncs + consumes), or a private note whose bytes are its only copy is
      // stranded in the dormant SW store. Both the import and the trailing sync
      // route through the proxy (reusing its existing methods); flag-OFF each is a
      // pass-through to the same inline client under this lock, so the behavior is
      // byte-identical to before.
      try {
        const noteId = await withWasmClientLock(async hold => {
          const id = await midenClientProxy.importNoteBytes(noteBytes);
          // The import is a network round trip, and an eviction during it releases the
          // mutex without stopping this callback — so the sync below would run with no
          // mutex held, concurrently with whoever holds it now. Throwing instead takes
          // the catch below, which queues the bytes: the note is preserved either way,
          // and the queue's own pass re-imports it under a hold that is actually ours.
          if (getCurrentWasmLockHold() !== hold) {
            throw new WasmClientPoisonedError('watchdog', new Error('manual note import abandoned after the import'));
          }
          await midenClientProxy.syncState();
          return id;
        });
        return { type: WalletMessageType.ImportNoteBytesResponse, noteId };
      } catch (e) {
        // Don't lose the note on a transient blip (resilience gap 1): queue the
        // bytes for the background import loop (wall-clock retry + dead-letter)
        // before surfacing the error, so a manual import isn't lost to one blip.
        // Both abandonment shapes count, not just a network blip. A watchdog eviction
        // and an offscreen deadline kill say the same thing this queue exists for —
        // "we do not know whether this landed" — and neither matches
        // `isLikelyNetworkError`, whose tokens are transport text: the poison message
        // is closed wallet-authored text. So an eviction took the not-transient path
        // and dropped the bytes from the one mechanism built to preserve them, which
        // for a private note can be the only copy of the funds it carries. Matches
        // the queue's own classifier (`notes.ts`, `transient`).
        if (isLikelyNetworkError(e) || isWasmClientPoisonedError(e) || isOperationAbortedError(e)) {
          // Logged rather than swallowed: the throw below reports the IMPORT
          // failure, which says nothing about whether the background retry was
          // actually armed. Losing both silently is what made this look like a
          // blip the loop would clean up when nothing had been queued at all.
          await queueNoteImport(req.noteBytes).catch(queueError =>
            logger.error('[ImportNoteBytesRequest] failed to queue the note for background retry', queueError)
          );
        }
        throw e;
      }
    }
    case WalletMessageType.RetryDeadletteredNotesRequest: {
      const { requeued } = await Actions.retryDeadletteredNotes();
      return { type: WalletMessageType.RetryDeadletteredNotesResponse, requeued };
    }
    case WalletMessageType.ExportNoteRequest: {
      const exportedBytes = await withWasmClientLock(async hold =>
        midenClientProxy.exportNote(req.noteId, NoteExportType.DETAILS, () =>
          assertWasmHoldCurrent(hold, 'inside the note export, before serializing the export')
        )
      );
      const exportedB64 = Buffer.from(exportedBytes).toString('base64');
      return { type: WalletMessageType.ExportNoteResponse, noteBytes: exportedB64 };
    }
    case WalletMessageType.GetInputNoteDetailsRequest: {
      if (!req.noteIds.length) {
        return { type: WalletMessageType.GetInputNoteDetailsResponse, notes: [] };
      }
      // Route through the proxy so flag-ON the invalid-note detection reads the
      // OFFSCREEN client's canonical synced state, not the dormant SW store (issue
      // #260, slice 7-reads). Flag-OFF the proxy runs the exact same per-id
      // getInputNote loop + reach-through reduction inline under this lock, so the
      // response is byte-identical to before. The caller owns the WASM lock (as with
      // the other flag-off proxy reads), so keep the withWasmClientLock wrapper.
      const notes = await withWasmClientLock(async () => midenClientProxy.getSerializedInputNoteDetails(req.noteIds));
      return { type: WalletMessageType.GetInputNoteDetailsResponse, notes };
    }
    case WalletMessageType.SpeculateSendRequest: {
      // Fire-and-forget. SpeculationManager queues at most one pending; if
      // it's already running an identical speculation, this is a no-op.
      // No withWasmClientLock here — the manager handles serialization
      // internally (it calls executeAndProveForSpeculation which does its
      // own execute under-lock + offscreen prove with yieldWasmClientLock).
      const mgr = getSpeculationManager();
      if (mgr) {
        mgr.speculate({
          accountId: req.accountId,
          recipientAccountId: req.recipientAccountId,
          faucetId: req.faucetId,
          noteType: req.noteType,
          amount: BigInt(req.amount)
        });
      }
      return { type: WalletMessageType.SpeculateSendResponse };
    }
    case WalletMessageType.SpeculateInvalidate: {
      const mgr = getSpeculationManager();
      mgr?.invalidate();
      return { type: WalletMessageType.SpeculateInvalidateResponse };
    }
    // case WalletMessageType.SendTrackEventRequest:
    //   await Analytics.trackEvent(req);
    //   return { type: WalletMessageType.SendTrackEventResponse };
    // case WalletMessageType.SendPageEventRequest:
    //   await Analytics.pageEvent(req);
    //   return { type: WalletMessageType.SendPageEventResponse };
    // case WalletMessageType.SendPerformanceEventRequest:
    //   await Analytics.performanceEvent(req);
    //   return { type: WalletMessageType.SendPerformanceEventResponse };
    case WalletMessageType.GetStateRequest:
      const state = await Actions.getFrontState();
      return {
        type: WalletMessageType.GetStateResponse,
        state
      };
    case WalletMessageType.NewWalletRequest:
      console.log('[processRequest] NEW_WALLET_REQUEST received, calling registerNewWallet...');
      try {
        await Actions.registerNewWallet(
          req.walletType,
          req.password,
          req.mnemonic,
          req.ownMnemonic,
          req.guardianEndpoint
        );
        console.log('[processRequest] registerNewWallet completed successfully');
      } catch (err: unknown) {
        console.error('[processRequest] registerNewWallet FAILED:', err);
        throw err;
      }
      return { type: WalletMessageType.NewWalletResponse };
    case WalletMessageType.ImportFromClientRequest:
      await Actions.registerImportedWallet(req.password, req.mnemonic, req.walletAccounts);
      return { type: WalletMessageType.ImportFromClientResponse };
    case WalletMessageType.UnlockRequest:
      await Actions.unlock(req.password);
      return { type: WalletMessageType.UnlockResponse };
    case WalletMessageType.LockRequest:
      await Actions.lock();
      return { type: WalletMessageType.LockResponse };
    case WalletMessageType.CreateAccountRequest:
      await Actions.createHDAccount(req.walletType, req.name);
      return { type: WalletMessageType.CreateAccountResponse };
    // case WalletMessageType.DecryptCiphertextsRequest:
    //   const texts = await Actions.decryptCiphertexts(req.accPublicKey, req.ciphertexts);
    //   return { type: WalletMessageType.DecryptCiphertextsResponse, texts: texts };
    case WalletMessageType.UpdateCurrentAccountRequest:
      await Actions.updateCurrentAccount(req.accountPublicKey);
      return { type: WalletMessageType.UpdateCurrentAccountResponse };
    // case WalletMessageType.RevealPublicKeyRequest:
    //   const publicKey = await Actions.revealPublicKey(req.accountPublicKey);
    //   return {
    //     type: WalletMessageType.RevealPublicKeyResponse,
    //     publicKey
    //   };
    // case WalletMessageType.RevealViewKeyRequest:
    //   const viewKey = await Actions.revealViewKey(req.accountPublicKey, req.password);
    //   return {
    //     type: WalletMessageType.RevealViewKeyResponse,
    //     viewKey
    //   };
    case WalletMessageType.RevealPrivateKeyRequest:
      const privateKey = await Actions.revealPrivateKey(req.accountPublicKey, req.password);
      return {
        type: WalletMessageType.RevealPrivateKeyResponse,
        privateKey: privateKey ?? ''
      };
    case WalletMessageType.RevealHotKeyRequest: {
      const hotPrivateKey = await Actions.revealHotKey(req.accountPublicKey, req.password);
      return {
        type: WalletMessageType.RevealHotKeyResponse,
        hotPrivateKey: hotPrivateKey ?? ''
      };
    }
    case WalletMessageType.RevealGuardianKeysRequest: {
      const keys = await Actions.revealGuardianKeys(req.accountPublicKey, req.password);
      return {
        type: WalletMessageType.RevealGuardianKeysResponse,
        coldPrivateKey: keys?.coldPrivateKey ?? '',
        coldPublicKey: keys?.coldPublicKey ?? '',
        hotPublicKey: keys?.hotPublicKey
      };
    }
    case WalletMessageType.RevealMnemonicRequest:
      const mnemonic = await Actions.revealMnemonic(req.password);
      return {
        type: WalletMessageType.RevealMnemonicResponse,
        mnemonic
      };
    case WalletMessageType.RemoveAccountRequest:
      await Actions.removeAccount(req.accountPublicKey, req.password);
      return {
        type: WalletMessageType.RemoveAccountResponse
      };
    case WalletMessageType.EditAccountRequest:
      await Actions.editAccount(req.accountPublicKey, req.name);
      return {
        type: WalletMessageType.EditAccountResponse
      };
    case WalletMessageType.ImportAccountRequest:
      const importedAccountPublicKey = await Actions.importAccount(req.privateKey, req.name);
      return {
        type: WalletMessageType.ImportAccountResponse,
        accountPublicKey: importedAccountPublicKey ?? ''
      };
    // case WalletMessageType.ImportWatchOnlyAccountRequest:
    //   await Actions.importWatchOnlyAccount(req.viewKey);
    //   return {
    //     type: WalletMessageType.ImportWatchOnlyAccountResponse
    //   };
    // case WalletMessageType.ImportMnemonicAccountRequest:
    //   await Actions.importMnemonicAccount(req.mnemonic, req.password, req.derivationPath);
    //   return {
    //     type: WalletMessageType.ImportMnemonicAccountResponse
    //   };
    case WalletMessageType.UpdateSettingsRequest:
      await Actions.updateSettings(req.settings);
      return {
        type: WalletMessageType.UpdateSettingsResponse
      };
    case WalletMessageType.SignTransactionRequest:
      const signature = await Actions.signTransaction(req.publicKey, req.signingInputs);
      return {
        type: WalletMessageType.SignTransactionResponse,
        signature
      };
    case WalletMessageType.SignWordRequest:
      const wordSignature = await Actions.signWord(req.publicKey, req.wordHex);
      return {
        type: WalletMessageType.SignWordResponse,
        signature: wordSignature
      };
    case WalletMessageType.SignEvmRequest:
      const evmSignResult = await Actions.signEvm(req.accountPublicKey, req.operation);
      return {
        type: WalletMessageType.SignEvmResponse,
        result: evmSignResult
      };
    case WalletMessageType.PersistNewHotKeyRequest:
      await Actions.persistNewHotKey(req.newHotPubKey, req.newHotCiphertext);
      return {
        type: WalletMessageType.PersistNewHotKeyResponse
      };
    case WalletMessageType.SwapHotKeyRequest:
      await Actions.swapHotKey(req.accountPublicKey, req.newHotPubKey);
      return {
        type: WalletMessageType.SwapHotKeyResponse
      };
    case WalletMessageType.SetGuardianEndpointRequest:
      await Actions.setGuardianEndpoint(req.accountPublicKey, req.guardianEndpoint);
      return {
        type: WalletMessageType.SetGuardianEndpointResponse
      };
    case WalletMessageType.SetGuardianOperatorCommitmentRequest:
      await Actions.setGuardianOperatorCommitment(req.accountPublicKey, req.guardianOperatorCommitment);
      return {
        type: WalletMessageType.SetGuardianOperatorCommitmentResponse
      };
    case WalletMessageType.SetGuardianSyncStatusRequest:
      await Actions.setGuardianSyncStatus(req.accountPublicKey, req.guardianSyncStatus);
      return {
        type: WalletMessageType.SetGuardianSyncStatusResponse
      };
    case WalletMessageType.CheckGuardianDriftRequest:
      const driftStatus = await Actions.checkGuardianDrift(req.accountPublicKey);
      return {
        type: WalletMessageType.CheckGuardianDriftResponse,
        guardianSyncStatus: driftStatus
      };
    case WalletMessageType.ApplyUserGuardianEndpointRequest:
      const applied = await Actions.applyUserGuardianEndpoint(req.accountPublicKey, req.guardianEndpoint);
      return {
        type: WalletMessageType.ApplyUserGuardianEndpointResponse,
        applied
      };
    case WalletMessageType.StartGuardianRecoveryRequest:
      const recoveryStarted = await Actions.startGuardianRecovery(req.accountPublicKey);
      return {
        type: WalletMessageType.StartGuardianRecoveryResponse,
        started: recoveryStarted
      };
    case WalletMessageType.GetPublicKeyForCommitmentRequest:
      const commitmentPublicKey = await Actions.getPublicKeyForCommitment(req.commitment);
      return {
        type: WalletMessageType.GetPublicKeyForCommitmentResponse,
        publicKey: commitmentPublicKey
      };
    case WalletMessageType.GetAuthSecretKeyRequest:
      const key = await Actions.getAuthSecretKey(req.key);
      return {
        type: WalletMessageType.GetAuthSecretKeyResponse,
        key
      };
    case MidenMessageType.DAppGetAllSessionsRequest:
      const allSessions = await Actions.getAllDAppSessions();
      return {
        type: MidenMessageType.DAppGetAllSessionsResponse,
        sessions: allSessions
      };
    case MidenMessageType.DAppRemoveSessionRequest:
      const sessions = await Actions.removeDAppSession(req.origin);
      return {
        type: MidenMessageType.DAppRemoveSessionResponse,
        sessions
      };
    case MidenMessageType.PageRequest:
      const dAppEnabled = await Actions.isDAppEnabled();
      if (dAppEnabled) {
        if (req.payload === 'PING') {
          return {
            type: MidenMessageType.PageResponse,
            payload: 'PONG'
          };
        }
        // PR-4 chunk 8: thread sessionId through (extension flow leaves
        // it undefined; mobile/desktop multi-instance pass it).
        const resPayload = await Actions.processDApp(req.origin, req.payload, (req as any).sessionId);
        return {
          type: MidenMessageType.PageResponse,
          payload: resPayload ?? null
        };
      }
      break;
    // case WalletMessageType.GetOwnedRecordsRequest:
    // const records = await Actions.getOwnedRecords(req.accPublicKey);
    // return {
    //   type: WalletMessageType.GetOwnedRecordsResponse,
    //   records
    // };
  }
}
