import { Runtime } from 'webextension-polyfill';

import { queueNoteImport } from 'lib/miden/activity';
import { isLikelyNetworkError } from 'lib/miden/activity/connectivity-classify';
import * as Actions from 'lib/miden/back/actions';
import { intercom } from 'lib/miden/back/defaults';
import { handleOffscreenSignRequest, markOpStarted, midenClientProxy } from 'lib/miden/back/miden-client-proxy';
import {
  OFFSCREEN_OP_STARTED,
  OFFSCREEN_SIGN_REQUEST,
  SW_TARGET,
  type OffscreenSignRequest
} from 'lib/miden/back/offscreen-codec';
import { getSpeculationManager, initSpeculationManager } from 'lib/miden/back/speculation-manager';
import { store, toFront } from 'lib/miden/back/store';
import { doSync } from 'lib/miden/back/sync-manager';
import { startTransactionProcessing, swSignCallback } from 'lib/miden/back/transaction-processor';
import { loadEndpointOverrides } from 'lib/miden-chain/effective-endpoints';
import { primeNativeAssetId } from 'lib/miden-chain/native-asset';
import { WalletMessageType, WalletRequest, WalletResponse } from 'lib/shared/types';

import { NoteExportType } from '../sdk/constants';
import { getMidenClient, withWasmClientLock } from '../sdk/miden-client';
import { MidenMessageType } from '../types';

// frontStore is initialized lazily inside start() because with Vite's TLA stripping,
// `store` may not be initialized at module scope evaluation time.
let frontStore: ReturnType<typeof store.map> | null = null;

export async function start() {
  console.log('Miden background script started');
  intercom.onRequest(processRequest);
  registerOffscreenSignHandler();

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
function registerOffscreenSignHandler(): void {
  if (offscreenSignHandlerRegistered) return;
  if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage?.addListener) return;
  offscreenSignHandlerRegistered = true;
  chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse: (r?: unknown) => void) => {
    // A SW-targeted message is either an OFFSCREEN_SIGN_REQUEST or an
    // OFFSCREEN_OP_STARTED (distinct `type` literals), so type `m` loosely and
    // discriminate on `type` below.
    const m = msg as { target?: string; type?: string; op_id?: string; sign_id?: string } | undefined;
    if (m?.target !== SW_TARGET) return false;
    // Execution-start signal (issue #260 flip-prep #3): the op named by `op_id`
    // has won the offscreen WASM mutex and is about to execute — arm its write
    // deadline now. Fire-and-forget: no async response, so don't hold the port.
    if (m.type === OFFSCREEN_OP_STARTED) {
      if (typeof m.op_id === 'string') markOpStarted(m.op_id);
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
        const noteId = await withWasmClientLock(async () => {
          const id = await midenClientProxy.importNoteBytes(noteBytes);
          await midenClientProxy.syncState();
          return id;
        });
        return { type: WalletMessageType.ImportNoteBytesResponse, noteId };
      } catch (e) {
        // Don't lose the note on a transient blip (resilience gap 1): queue the
        // bytes for the background import loop (wall-clock retry + dead-letter)
        // before surfacing the error, so a manual import isn't lost to one blip.
        if (isLikelyNetworkError(e)) {
          await queueNoteImport(req.noteBytes).catch(() => {});
        }
        throw e;
      }
    }
    case WalletMessageType.ExportNoteRequest: {
      const exportedBytes = await withWasmClientLock(async () =>
        midenClientProxy.exportNote(req.noteId, NoteExportType.DETAILS)
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
    case WalletMessageType.ReportTelemetryEventRequest:
      return await Actions.handleReportTelemetryEvent(req);
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
