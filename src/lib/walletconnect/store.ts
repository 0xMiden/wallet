import type EthereumProviderType from '@walletconnect/ethereum-provider';
import { create } from 'zustand';

import { getProvider, resetProvider } from './provider';

export type WcStatus = 'idle' | 'connecting' | 'connected' | 'disconnecting';

/**
 * The WC ethereum-provider exposes `accounts` / `chainId` as derived fields
 * but doesn't always refresh them after a relay reconnect — `session.namespaces`
 * is the source of truth. Pulls eip155 accounts from CAIP-10 format
 * (`eip155:<chainId>:0x<addr>`) and falls back to the provider's own fields
 * if the session isn't yet readable.
 */
function readSessionState(provider: EthereumProviderType): { accounts: string[]; chainId: number | null } {
  const session = provider.session;
  const eip155 = session?.namespaces?.eip155;
  if (eip155 && eip155.accounts.length > 0) {
    const parsed = eip155.accounts.map(a => {
      const [, chainStr, addr] = a.split(':');
      return { chainId: chainStr ? parseInt(chainStr, 10) : null, address: addr ?? '' };
    });
    const accounts = parsed.map(p => p.address).filter(a => a.length > 0);
    const chainId = parsed[0]?.chainId ?? provider.chainId ?? null;
    return { accounts, chainId };
  }
  return {
    accounts: provider.accounts ?? [],
    chainId: provider.chainId ?? null
  };
}

type WcStoreState = {
  status: WcStatus;
  uri: string | null;
  address: string | null;
  chainId: number | null;
  accounts: string[];
  error: string | null;
};

type WcStoreActions = {
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  request: <T = unknown>(args: { method: string; params?: unknown[] | object }) => Promise<T>;
  switchChain: (chainId: number) => Promise<void>;
  hydrate: () => Promise<void>;
};

type WcStore = WcStoreState & WcStoreActions;

const INITIAL_STATE: WcStoreState = {
  status: 'idle',
  uri: null,
  address: null,
  chainId: null,
  accounts: [],
  error: null
};

let listenersAttached = false;

export const useWcStore = create<WcStore>((set, get) => {
  async function attachListeners(): Promise<void> {
    if (listenersAttached) return;
    const provider = await getProvider();

    provider.on('display_uri', (uri: string) => {
      console.log('[wc] display_uri');
      set({ uri, status: 'connecting' });
    });

    provider.on('connect', () => {
      const { accounts, chainId } = readSessionState(provider);
      console.log('[wc] connect', { accounts, chainId, rawAccounts: provider.accounts });
      set({
        status: 'connected',
        uri: null,
        accounts,
        address: accounts[0] ?? null,
        chainId,
        error: null
      });
    });

    provider.on('disconnect', () => {
      console.log('[wc] disconnect');
      set({ ...INITIAL_STATE });
    });

    provider.on('accountsChanged', (accounts: string[]) => {
      console.log('[wc] accountsChanged', accounts);
      set({ accounts, address: accounts[0] ?? null });
    });

    provider.on('chainChanged', (chainId: string) => {
      const id = typeof chainId === 'string' ? parseInt(chainId, 16) : chainId;
      console.log('[wc] chainChanged', id);
      set({ chainId: id });
    });

    listenersAttached = true;
  }

  return {
    ...INITIAL_STATE,

    async hydrate() {
      const provider = await getProvider();
      await attachListeners();
      const { accounts, chainId } = readSessionState(provider);
      console.log('[wc] hydrate', {
        hasSession: !!provider.session,
        accounts,
        chainId,
        rawAccounts: provider.accounts,
        namespaceAccounts: provider.session?.namespaces?.eip155?.accounts
      });
      if (provider.session) {
        set({
          status: 'connected',
          accounts,
          address: accounts[0] ?? null,
          chainId,
          uri: null
        });
      }
    },

    async connect() {
      if (get().status === 'connecting' || get().status === 'connected') return;
      set({ status: 'connecting', uri: null, error: null });
      try {
        const provider = await getProvider();
        await attachListeners();
        await provider.connect();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to connect';
        set({ status: 'idle', uri: null, error: message });
        throw err;
      }
    },

    async disconnect() {
      const provider = await getProvider();
      set({ status: 'disconnecting' });
      try {
        if (provider.session) {
          await provider.disconnect();
        }
      } finally {
        resetProvider();
        listenersAttached = false;
        set({ ...INITIAL_STATE });
      }
    },

    async request<T = unknown>(args: { method: string; params?: unknown[] | object }): Promise<T> {
      const provider = await getProvider();
      return provider.request<T>(args);
    },

    async switchChain(chainId: number) {
      const provider = await getProvider();
      const hex = `0x${chainId.toString(16)}`;
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
      set({ chainId });
    }
  };
});
