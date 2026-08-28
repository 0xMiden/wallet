import * as Actions from 'lib/miden/back/actions';
import { MidenMessageType } from 'lib/miden/types';
import { WalletMessageType, WalletRequest, WalletResponse } from 'lib/shared/types';

/**
 * The ONE request switch shared by both in-process intercom adapters (mobile via
 * Capacitor, desktop via Tauri). Neither platform has a service worker, so both
 * call the backend `Actions` directly instead of port-messaging `back/main.ts`.
 *
 * It lives in its own module because the two adapters had drifted: desktop-adapter
 * handled 16 message types while mobile-adapter handled 27, and the 11 it was
 * missing were exactly the guardian surface (`SignWordRequest`,
 * `RevealHotKeyRequest`, `CheckGuardianDriftRequest`, …). Those fell through to
 * `default:`, which returns `undefined`, and every store wrapper in
 * `lib/store/index.ts` then dereferences the response — so guardian sync, the
 * hot-key rotation gate and "Reveal guardian keys" failed on desktop with a
 * TypeError that read to the user as a wrong password. One switch, two callers,
 * no drift.
 *
 * `label` only names the adapter in the unknown-type warning; behavior is identical.
 */
export async function processInProcessRequest(req: WalletRequest, label: string): Promise<WalletResponse | void> {
  switch (req?.type) {
    case WalletMessageType.GetStateRequest: {
      const state = await Actions.getFrontState();
      return {
        type: WalletMessageType.GetStateResponse,
        state
      };
    }

    case WalletMessageType.NewWalletRequest:
      // No casts: `WalletRequest` is a discriminated union, so this case narrows
      // `req` to `NewWalletRequest` and the compiler checks the call. It used to
      // pass `(password, mnemonic, ownMnemonic)` through `as any` on desktop,
      // which dropped `walletType`/`guardianEndpoint` and shifted every remaining
      // argument one position left — `Vault.spawn` then wiped storage and threw.
      await Actions.registerNewWallet(
        req.walletType,
        req.password,
        req.mnemonic,
        req.ownMnemonic,
        req.guardianEndpoint
      );
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

    case WalletMessageType.UpdateCurrentAccountRequest:
      await Actions.updateCurrentAccount(req.accountPublicKey);
      return { type: WalletMessageType.UpdateCurrentAccountResponse };

    case WalletMessageType.RevealMnemonicRequest: {
      const mnemonic = await Actions.revealMnemonic(req.password);
      return {
        type: WalletMessageType.RevealMnemonicResponse,
        mnemonic
      };
    }

    case WalletMessageType.RevealPrivateKeyRequest: {
      const privateKey = await Actions.revealPrivateKey(req.accountPublicKey, req.password);
      return {
        type: WalletMessageType.RevealPrivateKeyResponse,
        privateKey: privateKey ?? ''
      };
    }

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

    case WalletMessageType.ImportAccountRequest: {
      const importedAccountPublicKey = await Actions.importAccount(req.privateKey, req.name);
      return {
        type: WalletMessageType.ImportAccountResponse,
        accountPublicKey: importedAccountPublicKey ?? ''
      };
    }

    case WalletMessageType.UpdateSettingsRequest:
      await Actions.updateSettings(req.settings);
      return {
        type: WalletMessageType.UpdateSettingsResponse
      };

    case WalletMessageType.SignTransactionRequest: {
      const signature = await Actions.signTransaction(req.publicKey, req.signingInputs);
      return {
        type: WalletMessageType.SignTransactionResponse,
        signature
      };
    }

    case WalletMessageType.SignWordRequest: {
      const wordSignature = await Actions.signWord(req.publicKey, req.wordHex);
      return {
        type: WalletMessageType.SignWordResponse,
        signature: wordSignature
      };
    }

    case WalletMessageType.SignEvmRequest: {
      const evmSignResult = await Actions.signEvm(req.accountPublicKey, req.operation);
      return {
        type: WalletMessageType.SignEvmResponse,
        result: evmSignResult
      };
    }

    case WalletMessageType.PersistNewHotKeyRequest: {
      await Actions.persistNewHotKey(req.newHotPubKey, req.newHotCiphertext);
      return {
        type: WalletMessageType.PersistNewHotKeyResponse
      };
    }

    case WalletMessageType.SwapHotKeyRequest: {
      await Actions.swapHotKey(req.accountPublicKey, req.newHotPubKey);
      return {
        type: WalletMessageType.SwapHotKeyResponse
      };
    }

    case WalletMessageType.SetGuardianEndpointRequest: {
      await Actions.setGuardianEndpoint(req.accountPublicKey, req.guardianEndpoint);
      return {
        type: WalletMessageType.SetGuardianEndpointResponse
      };
    }

    case WalletMessageType.SetGuardianOperatorCommitmentRequest: {
      await Actions.setGuardianOperatorCommitment(req.accountPublicKey, req.guardianOperatorCommitment);
      return {
        type: WalletMessageType.SetGuardianOperatorCommitmentResponse
      };
    }

    case WalletMessageType.SetGuardianSyncStatusRequest: {
      await Actions.setGuardianSyncStatus(req.accountPublicKey, req.guardianSyncStatus);
      return {
        type: WalletMessageType.SetGuardianSyncStatusResponse
      };
    }

    case WalletMessageType.CheckGuardianDriftRequest: {
      const guardianSyncStatus = await Actions.checkGuardianDrift(req.accountPublicKey);
      return {
        type: WalletMessageType.CheckGuardianDriftResponse,
        guardianSyncStatus
      };
    }

    case WalletMessageType.ApplyUserGuardianEndpointRequest: {
      const outcome = await Actions.applyUserGuardianEndpoint(req.accountPublicKey, req.guardianEndpoint);
      return {
        type: WalletMessageType.ApplyUserGuardianEndpointResponse,
        outcome
      };
    }

    case WalletMessageType.StartGuardianRecoveryRequest: {
      const started = await Actions.startGuardianRecovery(req.accountPublicKey);
      return {
        type: WalletMessageType.StartGuardianRecoveryResponse,
        started
      };
    }

    case WalletMessageType.GetPublicKeyForCommitmentRequest: {
      const publicKey = await Actions.getPublicKeyForCommitment(req.commitment);
      return {
        type: WalletMessageType.GetPublicKeyForCommitmentResponse,
        publicKey
      };
    }

    case WalletMessageType.GetAuthSecretKeyRequest: {
      const key = await Actions.getAuthSecretKey(req.key);
      return {
        type: WalletMessageType.GetAuthSecretKeyResponse,
        key
      };
    }

    case MidenMessageType.DAppGetAllSessionsRequest: {
      const allSessions = await Actions.getAllDAppSessions();
      return {
        type: MidenMessageType.DAppGetAllSessionsResponse,
        sessions: allSessions
      };
    }

    case MidenMessageType.DAppRemoveSessionRequest: {
      const sessions = await Actions.removeDAppSession(req.origin);
      return {
        type: MidenMessageType.DAppRemoveSessionResponse,
        sessions
      };
    }

    case MidenMessageType.PageRequest: {
      const dAppEnabled = await Actions.isDAppEnabled();
      if (dAppEnabled) {
        if (req.payload === 'PING') {
          return {
            type: MidenMessageType.PageResponse,
            payload: 'PONG'
          };
        }
        // PR-4 chunk 8: thread the multi-instance session id through if
        // present so confirmation prompts route to the right session.
        const resPayload = await Actions.processDApp(req.origin, req.payload, req.sessionId);
        return {
          type: MidenMessageType.PageResponse,
          /* c8 ignore next -- dApp response nullish fallback */
          payload: resPayload ?? null
        };
      }
      break;
    }

    // #788 follow-up: the Activity notice's Retry. Mobile/desktop own the
    // import pass in this single realm, so the drain runs right here.
    case WalletMessageType.RetryDeadletteredNotesRequest: {
      const { requeued } = await Actions.retryDeadletteredNotes();
      return { type: WalletMessageType.RetryDeadletteredNotesResponse, requeued };
    }

    default:
      console.warn(`${label}: Unknown request type`, req?.type);
  }
}
