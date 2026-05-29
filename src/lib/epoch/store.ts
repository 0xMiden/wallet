import type { CollateralType, IntentTransactionStatus, SolveIntentParams } from '@epoch-protocol/epoch-intents-sdk';
import { sepolia } from 'viem/chains';
import { create } from 'zustand';

import { getProvider, useWcStore } from 'lib/walletconnect';

import {
  type CrossChainQuote,
  type EVMToMidenQuote,
  buildCrossChainIntent,
  buildEVMToMidenIntent,
  getCrossChainQuote,
  getEVMToMidenQuote
} from './bridge';
import { getEpochSdk } from './sdk';
import type { CrossChainIntentParams, EVMToMidenIntentParams, IntentResult } from './types';

export type EpochFlow = 'evm-to-miden' | 'miden-to-evm';

export type EpochStatus = 'idle' | 'quoting' | 'quoted' | 'signing' | 'pending' | 'done' | 'failed';

type Quote = EVMToMidenQuote | CrossChainQuote;

interface EpochState {
  status: EpochStatus;
  flow: EpochFlow | null;
  quote: Quote | null;
  intent: IntentResult | null;
  pollResults: IntentTransactionStatus[] | null;
  error: string | null;
}

interface MidenExecuteOpts {
  collateralType?: CollateralType;
  midenSourceAccount?: string;
  createMidenP2IDNote?: SolveIntentParams['createMidenP2IDNote'];
}

interface EpochActions {
  quoteEVMToMiden(params: EVMToMidenIntentParams, sponsorAddress: string): Promise<void>;
  executeEVMToMiden(): Promise<void>;
  quoteMidenToEVM(params: CrossChainIntentParams, sponsorAddress: string): Promise<void>;
  executeMidenToEVM(opts?: MidenExecuteOpts): Promise<void>;
  poll(): Promise<void>;
  reset(): void;
}

type EpochStore = EpochState & EpochActions;

const INITIAL_STATE: EpochState = {
  status: 'idle',
  flow: null,
  quote: null,
  intent: null,
  pollResults: null,
  error: null
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error';
}

export const useEpochStore = create<EpochStore>((set, get) => ({
  ...INITIAL_STATE,

  async quoteEVMToMiden(params, sponsorAddress) {
    set({ status: 'quoting', flow: 'evm-to-miden', error: null, intent: null, pollResults: null });
    try {
      const sdk = await getEpochSdk();
      if (!sdk) throw new Error('Connect an EVM wallet first');
      const quote = await getEVMToMidenQuote(sdk, params, sponsorAddress);
      console.log('[epoch] EVM→Miden quote', quote);
      set({ status: 'quoted', quote });
    } catch (err) {
      console.error('[epoch] quoteEVMToMiden failed', err);
      set({ status: 'failed', error: errorMessage(err) });
    }
  },

  async executeEVMToMiden() {
    const { status, flow, quote } = get();
    if (flow !== 'evm-to-miden' || status !== 'quoted' || !quote) {
      throw new Error('executeEVMToMiden requires a quoted EVM→Miden flow');
    }
    set({ status: 'signing', error: null });
    try {
      // viem's writeContract rejects when walletClient.chain.id (Sepolia)
      // doesn't match the wallet's currently-selected chain. The WC session
      // namespace declares Sepolia but MetaMask's active chain can still be
      // anything (often mainnet) — our store's chainId mirrors the session,
      // NOT the wallet's eth_chainId. So we always force a switch and then
      // verify with a direct eth_chainId query before continuing.
      const provider = await getProvider();
      await useWcStore.getState().switchChain(sepolia.id);
      const activeHex = await provider.request<string>({ method: 'eth_chainId' });
      const activeId = typeof activeHex === 'string' ? parseInt(activeHex, 16) : Number(activeHex);
      console.log('[epoch] post-switch eth_chainId', { activeHex, activeId });
      if (activeId !== sepolia.id) {
        throw new Error(
          `Wallet did not switch to Sepolia (currently ${activeId}). Please switch the network in your wallet and try again.`
        );
      }
      const sdk = await getEpochSdk();
      if (!sdk) throw new Error('Connect an EVM wallet first');
      const intent = await buildEVMToMidenIntent(sdk, {
        ...(quote as EVMToMidenQuote).params,
        preFetchedQuote: quote as EVMToMidenQuote
      });
      console.log('[epoch] EVM→Miden intent', intent);
      if (intent.error) {
        set({ status: 'failed', intent, error: intent.error });
        return;
      }
      set({ status: 'pending', intent });
    } catch (err) {
      console.error('[epoch] executeEVMToMiden failed', err);
      set({ status: 'failed', error: errorMessage(err) });
    }
  },

  async quoteMidenToEVM(params, sponsorAddress) {
    set({ status: 'quoting', flow: 'miden-to-evm', error: null, intent: null, pollResults: null });
    try {
      const sdk = await getEpochSdk({ forMidenFlow: true });
      if (!sdk) throw new Error('Connect an EVM wallet first');
      const quote = await getCrossChainQuote(sdk, params, sponsorAddress);
      console.log('[epoch] Miden→EVM quote', quote);
      set({ status: 'quoted', quote });
    } catch (err) {
      console.error('[epoch] quoteMidenToEVM failed', err);
      set({ status: 'failed', error: errorMessage(err) });
    }
  },

  async executeMidenToEVM(opts) {
    const { status, flow, quote } = get();
    if (flow !== 'miden-to-evm' || status !== 'quoted' || !quote) {
      throw new Error('executeMidenToEVM requires a quoted Miden→EVM flow');
    }
    set({ status: 'signing', error: null });
    try {
      const sdk = await getEpochSdk({ forMidenFlow: true });
      if (!sdk) throw new Error('Connect an EVM wallet first');
      const intent = await buildCrossChainIntent(sdk, {
        ...(quote as CrossChainQuote).params,
        preFetchedQuote: quote as CrossChainQuote,
        collateralType: opts?.collateralType,
        midenSourceAccount: opts?.midenSourceAccount,
        createMidenP2IDNote: opts?.createMidenP2IDNote
      });
      console.log('[epoch] Miden→EVM intent', intent);
      if (intent.error) {
        set({ status: 'failed', intent, error: intent.error });
        return;
      }
      set({ status: 'pending', intent });
    } catch (err) {
      console.error('[epoch] executeMidenToEVM failed', err);
      set({ status: 'failed', error: errorMessage(err) });
    }
  },

  async poll() {
    const { intent } = get();
    const address = useWcStore.getState().address;
    const nonce = intent?.intentNonce ?? intent?.solveResult?.nonce;
    if (!address || !nonce) return;
    try {
      const sdk = await getEpochSdk();
      if (!sdk) return;
      const results = await sdk.getIntentStatus(address, nonce);
      console.log('[epoch] poll', results);
      const allDone = results.length > 0 && results.every(r => r.status === 'completed' || r.status === 'success');
      set({ pollResults: results, status: allDone ? 'done' : 'pending' });
    } catch (err) {
      console.error('[epoch] poll failed', err);
    }
  },

  reset() {
    set({ ...INITIAL_STATE });
  }
}));
