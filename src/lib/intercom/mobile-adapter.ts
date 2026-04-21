import * as Actions from 'lib/miden/back/actions';
import { store, toFront } from 'lib/miden/back/store';
import { MidenMessageType } from 'lib/miden/types';
import { WalletMessageType, WalletRequest, WalletResponse } from 'lib/shared/types';

type SubscriptionCallback = (data: any) => void;

/**
 * Mobile adapter for intercom that directly calls backend handlers
 * instead of using browser extension port messaging.
 */
export class MobileIntercomAdapter {
  private initialized = false;
  private subscribers: Set<SubscriptionCallback> = new Set();

  /**
   * Initialize the mobile backend
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    console.log('MobileIntercomAdapter: Initializing backend');
    await Actions.init();

    // Watch store changes and notify subscribers
    const frontStore = store.map(toFront);
    frontStore.watch(() => {
      this.notifySubscribers({ type: WalletMessageType.StateUpdated });
    });

    this.initialized = true;
    console.log('MobileIntercomAdapter: Backend initialized');
  }

  /**
   * Makes a request directly to the backend handlers
   */
  async request(payload: WalletRequest): Promise<WalletResponse | void> {
    // Ensure backend is initialized
    if (!this.initialized) {
      await this.init();
    }

    return this.processRequest(payload);
  }

  /**
   * Subscribe to notifications (state updates)
   */
  subscribe(callback: SubscriptionCallback): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  /**
   * Process a request directly (same logic as main.ts processRequest)
   */
  private async processRequest(req: WalletRequest): Promise<WalletResponse | void> {
    switch (req?.type) {
      case WalletMessageType.GetStateRequest: {
        const state = await Actions.getFrontState();
        return {
          type: WalletMessageType.GetStateResponse,
          state
        };
      }

      case WalletMessageType.NewWalletRequest:
        await Actions.registerNewWallet(req.walletType, req.password, req.mnemonic, req.ownMnemonic);
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
            /* c8 ignore next -- dApp response nullish fallback, mobile-only */
            payload: resPayload ?? null
          };
        }
        break;
      }

      default:
        console.warn('MobileIntercomAdapter: Unknown request type', req?.type);
    }
  }

  /**
   * Notify all subscribers of a state change
   */
  private notifySubscribers(data: any): void {
    this.subscribers.forEach(callback => {
      try {
        callback(data);
      } catch (error) {
        console.error('MobileIntercomAdapter: Error in subscriber callback', error);
      }
    });
  }
}

// Singleton instance
let mobileAdapter: MobileIntercomAdapter | null = null;

/**
 * Gets the singleton mobile adapter instance
 */
export function getMobileIntercomAdapter(): MobileIntercomAdapter {
  if (!mobileAdapter) {
    mobileAdapter = new MobileIntercomAdapter();
  }
  return mobileAdapter;
}

export default MobileIntercomAdapter;
