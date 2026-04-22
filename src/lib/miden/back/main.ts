import { Runtime } from 'webextension-polyfill';

import * as Actions from 'lib/miden/back/actions';
import { intercom } from 'lib/miden/back/defaults';
import { store, toFront } from 'lib/miden/back/store';
import { doSync } from 'lib/miden/back/sync-manager';
import { startTransactionProcessing } from 'lib/miden/back/transaction-processor';
import { primeNativeAssetId } from 'lib/miden-chain/native-asset';
import { SerializedInputNoteDetail, WalletMessageType, WalletRequest, WalletResponse } from 'lib/shared/types';

import { NoteExportType } from '../sdk/constants';
import { getBech32AddressFromAccountId } from '../sdk/helpers';
import { getMidenClient, withWasmClientLock } from '../sdk/miden-client';
import { MidenMessageType } from '../types';

// frontStore is initialized lazily inside start() because with Vite's TLA stripping,
// `store` may not be initialized at module scope evaluation time.
let frontStore: ReturnType<typeof store.map> | null = null;

export async function start() {
  console.log('Miden background script started');
  intercom.onRequest(processRequest);

  // NOTE: The Vite sw-patches plugin injects await init_*() calls here
  // (between intercom registration and Actions.init)

  await Actions.init();

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

async function processRequest(req: WalletRequest, _port: Runtime.Port): Promise<WalletResponse | void> {
  console.log('[processRequest] type:', req?.type);
  switch (req?.type) {
    case WalletMessageType.SyncRequest:
      doSync().catch(err => console.warn('[SyncManager] Error:', err));
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
      const noteId = await withWasmClientLock(async () => {
        const client = await getMidenClient();
        const id = await client.importNoteBytes(noteBytes);
        await client.syncState();
        return id.toString();
      });
      return { type: WalletMessageType.ImportNoteBytesResponse, noteId };
    }
    case WalletMessageType.ExportNoteRequest: {
      const exportedBytes = await withWasmClientLock(async () => {
        const client = await getMidenClient();
        return client.exportNote(req.noteId, NoteExportType.DETAILS);
      });
      const exportedB64 = Buffer.from(exportedBytes).toString('base64');
      return { type: WalletMessageType.ExportNoteResponse, noteBytes: exportedB64 };
    }
    case WalletMessageType.GetInputNoteDetailsRequest: {
      if (!req.noteIds.length) {
        return { type: WalletMessageType.GetInputNoteDetailsResponse, notes: [] };
      }
      const serialized: SerializedInputNoteDetail[] = await withWasmClientLock(async () => {
        const client = await getMidenClient();
        const results: SerializedInputNoteDetail[] = [];
        for (const noteId of req.noteIds) {
          try {
            const record = await client.getInputNote(noteId);
            if (!record) continue;
            const assets = record
              .details()
              .assets()
              .fungibleAssets()
              .map((a: any) => ({
                amount: a.amount()?.toString() ?? '0',
                faucetId: a.faucetId() ? getBech32AddressFromAccountId(a.faucetId()) : ''
              }));
            results.push({
              noteId,
              state: record.state()?.toString() ?? 'Unknown',
              assets,
              nullifier: record.nullifier()?.toString() ?? ''
            });
          } catch {
            // Skip notes that can't be found
          }
        }
        return results;
      });
      return { type: WalletMessageType.GetInputNoteDetailsResponse, notes: serialized };
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
        await Actions.registerNewWallet(req.password, req.mnemonic, req.ownMnemonic);
        console.log('[processRequest] registerNewWallet completed successfully');
      } catch (err: any) {
        console.error('[processRequest] registerNewWallet FAILED:', err?.message, err?.stack?.slice(0, 500));
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
    // case WalletMessageType.RevealPrivateKeyRequest:
    //   const privateKey = await Actions.revealPrivateKey(req.accountPublicKey, req.password);
    //   return {
    //     type: WalletMessageType.RevealPrivateKeyResponse,
    //     privateKey
    //   };
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
      await Actions.importAccount(req.privateKey, req.encPassword);
      return {
        type: WalletMessageType.ImportAccountResponse
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
