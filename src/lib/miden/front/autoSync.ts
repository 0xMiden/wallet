import { isMobile } from 'lib/platform';
import { WalletState, WalletStatus } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';

import { getMidenClient, withWasmClientLock } from '../sdk/miden-client';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Debug info for iOS troubleshooting - exposed globally so UI can read it
export type SyncDebugInfo = {
  syncCount: number;
  lastSyncTime: string;
  lastBlockNum: number | null;
  lastError?: string;
};

// Global debug info that can be read by UI components
export const syncDebugInfo: SyncDebugInfo = {
  syncCount: 0,
  lastSyncTime: 'never',
  lastBlockNum: null,
  lastError: undefined
};

export class Sync {
  lastHeight: number = 0;
  lastRecordId: number = 0;
  getHeightFetchTimestamp: number = 0;
  state?: WalletState;
  ampCycles: number = 0;

  // Exposed for testing
  getCurrentUrl(): string {
    return window.location.href;
  }

  public updateState(state: WalletState) {
    const previousState = this.state;
    this.state = state;

    // When wallet becomes Ready, start the sync loop
    // (balance fetch is handled by syncFromBackend in Zustand store)
    const justBecameReady =
      state.status === WalletStatus.Ready && (!previousState || previousState.status !== WalletStatus.Ready);

    if (justBecameReady) {
      this.initializeAndSync();
    } else if (!previousState) {
      // First state update but not Ready yet - start sync loop (will wait until Ready)
      this.sync();
    }
  }

  /**
   * Start the sync loop when wallet becomes Ready.
   * Balance fetch is handled by syncFromBackend in the Zustand store (earliest possible point).
   */
  private initializeAndSync() {
    this.sync();
  }

  async sync() {
    const storeState = useWalletStore.getState();

    // Don't sync when wallet isn't ready (locked/idle) - no account to sync
    if (storeState.status !== WalletStatus.Ready) {
      await sleep(3000);
      await this.sync();
      return;
    }

    // Don't sync on the generating transaction page
    const isGeneratingUrl = this.getCurrentUrl().search('generating-transaction') > -1;
    if (isGeneratingUrl) {
      return;
    }

    // On mobile, don't sync while transaction modal is open to avoid lock contention
    if (isMobile() && storeState.isTransactionModalOpen) {
      console.log('[AutoSync] Skipping sync while transaction modal is open');
      await sleep(3000);
      await this.sync();
      return;
    }

    // Set syncing status to true before sync
    useWalletStore.getState().setSyncStatus(true);

    try {
      const blockNum = await withWasmClientLock(async () => {
        const client = await getMidenClient();
        if (!client) {
          syncDebugInfo.lastError = 'getMidenClient returned null';
          return null;
        }
        const syncSummary = await client.syncState();
        return syncSummary.blockNum();
      });

      if (blockNum !== null) {
        this.lastHeight = blockNum;
        syncDebugInfo.lastBlockNum = blockNum;
        syncDebugInfo.lastError = undefined;
      }
      syncDebugInfo.syncCount++;
      syncDebugInfo.lastSyncTime = new Date().toLocaleTimeString();
    } catch (error) {
      console.error('[AutoSync] Error during sync:', error);
      syncDebugInfo.lastError = String(error);
      syncDebugInfo.lastSyncTime = new Date().toLocaleTimeString();
    } finally {
      useWalletStore.getState().setSyncStatus(false);
    }
    await sleep(3000);
    await this.sync();
  }
}

export const AutoSync = new Sync();

export interface Keys {
  privateKey: string;
  viewKey: string;
}
