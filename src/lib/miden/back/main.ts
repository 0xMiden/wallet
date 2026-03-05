import { Runtime } from 'webextension-polyfill';

import * as Actions from 'lib/miden/back/actions';
import { intercom } from 'lib/miden/back/defaults';
import { store, toFront } from 'lib/miden/back/store';
import { WalletMessageType, WalletRequest, WalletResponse } from 'lib/shared/types';

import { MidenMessageType } from '../types';

const frontStore = store.map(toFront);

export async function start() {
  console.log('Miden background script started');
  intercom.onRequest(processRequest);
  await Actions.init();
  frontStore.watch(() => {
    intercom.broadcast({ type: WalletMessageType.StateUpdated });
  });
}

async function processRequest(req: WalletRequest, port: Runtime.Port): Promise<WalletResponse | void> {
  switch (req?.type) {
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
      await Actions.registerNewWallet(req.password, req.mnemonic, req.ownMnemonic);
      return { type: WalletMessageType.NewWalletResponse };
    case WalletMessageType.ImportFromClientRequest:
      await Actions.registerImportedWallet(req.password, req.mnemonic);
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
    case WalletMessageType.SignWordRequest:
      const wordSignature = await Actions.signWord(req.publicKey, req.wordHex);
      return {
        type: WalletMessageType.SignWordResponse,
        signature: wordSignature
      };
    case WalletMessageType.GetAuthSecretKeyRequest:
      const key = await Actions.getAuthSecretKey(req.key);
      return {
        type: WalletMessageType.GetAuthSecretKeyResponse,
        key
      };
    case WalletMessageType.GetPublicKeyForCommitmentRequest:
      const publicKey = await Actions.getPublicKeyForCommitment(req.publicKeyCommitment);
      return {
        type: WalletMessageType.GetPublicKeyForCommitmentResponse,
        publicKey
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
        const resPayload = await Actions.processDApp(req.origin, req.payload);
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
