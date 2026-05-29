import { sepolia } from '@reown/appkit/networks';
import type { AppKitNetwork } from '@reown/appkit/networks';
import { create } from 'zustand';

import { getModal } from './appkit';

export type WcStatus = 'idle' | 'connecting' | 'connected' | 'disconnecting';

/**
 * Numeric chain id → AppKit network. AppKit's `switchNetwork` takes a network
 * object, not an id, so the bridge layer's `switchChain(sepolia.id)` calls map
 * through here. Only chains we actually switch to need an entry.
 */
const NETWORKS_BY_ID: Record<number, AppKitNetwork> = {
  [sepolia.id]: sepolia
};

type WcStoreState = {
  status: WcStatus;
  address: string | null;
  chainId: number | null;
  accounts: string[];
  error: string | null;
};

type WcStoreActions = {
  /** Open AppKit's connect modal. No-op when already connected. */
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  switchChain: (chainId: number) => Promise<void>;
  /** Seed state from any persisted AppKit session and attach subscriptions. */
  hydrate: () => Promise<void>;
};

type WcStore = WcStoreState & WcStoreActions;

const INITIAL_STATE: WcStoreState = {
  status: 'idle',
  address: null,
  chainId: null,
  accounts: [],
  error: null
};

function toChainId(raw: number | string | undefined): number | null {
  if (raw === undefined) return null;
  return typeof raw === 'string' ? parseInt(raw, 10) : raw;
}

let subscribed = false;

export const useWcStore = create<WcStore>((set, get) => {
  // AppKit is the source of truth; we mirror its account/network state into the
  // store so non-React callers (lib/epoch's zustand actions) can read it
  // synchronously via `useWcStore.getState()`.
  function ensureSubscriptions(): void {
    if (subscribed) return;
    const modal = getModal();
    subscribed = true;

    modal.subscribeAccount(acc => {
      const address = acc.address ?? null;
      set(prev => ({
        address,
        accounts: address ? [address] : [],
        // Hold 'connecting' while the modal is open and not yet connected;
        // otherwise track AppKit's connection truth.
        status: acc.isConnected ? 'connected' : prev.status === 'connecting' ? 'connecting' : 'idle',
        error: null
      }));
    });

    modal.subscribeNetwork(net => {
      set({ chainId: toChainId(net.chainId) });
    });

    // When AppKit's modal closes while still unconnected, drop the transient
    // 'connecting' state so the UI doesn't hang on a spinner.
    modal.subscribeState(state => {
      if (!state.open && get().status === 'connecting' && !get().address) {
        set({ status: 'idle' });
      }
    });

    // Seed immediately in case a session was restored before we subscribed.
    const address = modal.getAddress('eip155') ?? null;
    set({
      address,
      accounts: address ? [address] : [],
      status: modal.getIsConnectedState() ? 'connected' : 'idle',
      chainId: toChainId(modal.getChainId())
    });
  }

  return {
    ...INITIAL_STATE,

    async hydrate() {
      ensureSubscriptions();
    },

    async connect() {
      ensureSubscriptions();
      if (get().status === 'connected') return;
      set({ status: 'connecting', error: null });
      try {
        // Resolves when the modal is shown, not on connect. Account/state
        // subscriptions drive the transition to 'connected' (or back to 'idle'
        // if the user dismisses the modal).
        await getModal().open();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to connect';
        set({ status: 'idle', error: message });
        throw err;
      }
    },

    async disconnect() {
      ensureSubscriptions();
      set({ status: 'disconnecting' });
      try {
        await getModal().disconnect();
      } finally {
        set({ ...INITIAL_STATE });
      }
    },

    async switchChain(chainId: number) {
      const network = NETWORKS_BY_ID[chainId];
      if (!network) throw new Error(`Unsupported chain ${chainId}`);
      await getModal().switchNetwork(network);
      set({ chainId });
    }
  };
});
