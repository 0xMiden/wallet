import type { CollateralType, IntentTransactionStatus, SolveIntentParams } from '@epoch-protocol/epoch-intents-sdk';
import { sepolia } from 'viem/chains';
import { create } from 'zustand';

import { registerPendingBridgeIn, resolveBridgeInNoteId } from 'lib/miden/activity/bridge-in';
import { updateBridgedReceivePhase } from 'lib/miden/transaction/complete';

import {
  type CrossChainQuote,
  type EVMToMidenQuote,
  buildCrossChainIntent,
  buildEVMToMidenIntent,
  getCrossChainQuote,
  getEVMToMidenQuote
} from './bridge';
import { getEvmConnection } from './client';
import { MIDEN_DESTINATION_CHAIN_ID } from './config';
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
  /**
   * EVM→Miden: Miden-side note id reported by intent polling once the solver
   * creates the P2ID note. The note is auto-consumed, so this is the wallet's
   * only handle for tagging the resulting consume row as a bridge-in.
   */
  midenNoteId: string | null;
  error: string | null;
  bridgeReceiveTxId: string | null;
}

interface MidenExecuteOpts {
  collateralType?: CollateralType;
  midenSourceAccount?: string;
  createMidenP2IDNote?: SolveIntentParams['createMidenP2IDNote'];
}

interface EpochActions {
  quoteEVMToMiden(params: EVMToMidenIntentParams, sponsorAddress: string): Promise<void>;
  executeEVMToMiden(bridgeReceiveTxId?: string): Promise<void>;
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
  midenNoteId: null,
  error: null,
  bridgeReceiveTxId: null
};

function firstString(source: unknown, keys: string[]): string | undefined {
  if (!source || typeof source !== 'object') return undefined;
  for (const key of keys) {
    const value: unknown = Reflect.get(source, key);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function isLegDone(result: IntentTransactionStatus): boolean {
  return result.status === 'completed' || result.status === 'success';
}

/**
 * EVM→Miden intents report per-leg statuses, and the source-chain (Sepolia)
 * entry can read `failed` with a null hash even when the deposit landed — e.g.
 *
 *   [{ status: 'success', chainId: 999999999, midenNoteId: '0x…' },
 *    { status: 'failed',  chainId: 11155111, transactionHash: null }]
 *
 * The Miden leg IS the destination fill, so it alone decides "done" for the
 * evm-to-miden flow; requiring every leg would leave the intent pending
 * forever. Other flows keep the all-legs rule.
 */
function isIntentDone(results: IntentTransactionStatus[], flow: EpochFlow | null): boolean {
  if (results.length === 0) return false;
  if (flow === 'evm-to-miden') {
    const midenLeg = results.find(r => r.chainId === MIDEN_DESTINATION_CHAIN_ID);
    if (midenLeg) return isLegDone(midenLeg);
  }
  return results.every(isLegDone);
}

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    // viem buries the wallet/RPC's real error several layers deep and shows a
    // generic top line (e.g. "An unknown RPC error occurred" — which on native
    // is what every wallet failure collapses to, since the native plugin
    // forwards only the message string and drops the JSON-RPC code). walk()
    // returns the root cause, whose details/shortMessage carry the actual
    // reason (e.g. "execution reverted", "user rejected", relay errors).
    const walk = Reflect.get(err, 'walk');
    if (typeof walk === 'function') {
      const root: unknown = Reflect.apply(walk, err, []);
      const rootMessage = firstString(root, ['details', 'shortMessage', 'message']);
      if (rootMessage) return rootMessage;
    }
    const message = firstString(err, ['details', 'shortMessage', 'message']);
    if (message) return message;
  }
  return err instanceof Error ? err.message : 'Unknown error';
}

export const useEpochStore = create<EpochStore>((set, get) => ({
  ...INITIAL_STATE,

  async quoteEVMToMiden(params, sponsorAddress) {
    set({
      status: 'quoting',
      flow: 'evm-to-miden',
      error: null,
      intent: null,
      pollResults: null,
      midenNoteId: null,
      bridgeReceiveTxId: null
    });
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

  async executeEVMToMiden(bridgeReceiveTxId) {
    const { status, flow, quote } = get();
    if (flow !== 'evm-to-miden' || status !== 'quoted' || !quote) {
      throw new Error('executeEVMToMiden requires a quoted EVM→Miden flow');
    }
    set({ status: 'signing', error: null, bridgeReceiveTxId: bridgeReceiveTxId ?? null });
    try {
      // viem's writeContract rejects when walletClient.chain.id (Sepolia)
      // doesn't match the wallet's currently-selected chain. The WC session
      // namespace declares Sepolia but MetaMask's active chain can still be
      // anything (often mainnet) — our store's chainId mirrors the session,
      // NOT the wallet's eth_chainId. So on web we verify the active chain
      // before continuing. The native Reown session carries the target chain
      // id in every signing request, so there is no active-chain to guard.
      const connection = await getEvmConnection();
      if (!connection.address) {
        throw new Error('Connect an EVM wallet first');
      }
      if (!connection.isNative && connection.chainId !== sepolia.id) {
        throw new Error(
          `Wallet did not switch to Sepolia (currently ${connection.chainId}). Please switch the network in your wallet and try again.`
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
        if (bridgeReceiveTxId) {
          await updateBridgedReceivePhase(bridgeReceiveTxId, 'failed', { error: intent.error });
        }
        return;
      }
      set({ status: 'pending', intent });

      // Park the intent metadata in storage NOW — if the user closes the
      // deposit screen before its polling loop ever reports the Miden note id,
      // the consume-completion hook does a one-shot poll against this record
      // and still tags the auto-consumed note as a bridge-in.
      const nonce = intent.intentNonce ?? intent.solveResult?.nonce;
      const evmTxHash = intent.solveResult?.depositResult?.transactionHash ?? intent.solveResult?.hash;
      if (bridgeReceiveTxId) {
        await updateBridgedReceivePhase(bridgeReceiveTxId, 'delivering', {
          intentNonce: nonce,
          evmTxHash
        });
      }
      if (nonce) {
        const evmParams = (quote as EVMToMidenQuote).params;
        await registerPendingBridgeIn(connection.address, nonce, {
          provider: 'epoch',
          sourceAmount: evmParams.evmAmount,
          sourceSymbol: quote.quoteResult.tokenInSymbol,
          intentNonce: nonce,
          evmTxHash,
          bridgeReceiveTxId
        }).catch(err => console.warn('[epoch] registerPendingBridgeIn failed', err));
      }
    } catch (err) {
      console.error('[epoch] executeEVMToMiden failed', err);
      const message = errorMessage(err);
      set({ status: 'failed', error: message });
      if (bridgeReceiveTxId) {
        await updateBridgedReceivePhase(bridgeReceiveTxId, 'failed', { error: message }).catch(() => undefined);
      }
    }
  },

  async quoteMidenToEVM(params, sponsorAddress) {
    set({ status: 'quoting', flow: 'miden-to-evm', error: null, intent: null, pollResults: null, midenNoteId: null });
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
    const { address } = await getEvmConnection();
    const nonce = intent?.intentNonce ?? intent?.solveResult?.nonce;
    if (!address || !nonce) return;
    try {
      const sdk = await getEpochSdk();
      if (!sdk) return;
      const results = await sdk.getIntentStatus(address, nonce);
      console.log('[epoch] poll', results);
      const allDone = isIntentDone(results, get().flow);
      // EVM→Miden fills carry the Miden-side note id as an extra field the SDK
      // type doesn't declare (the allocator JSON passes through untouched).
      const discoveredNoteId = results.map(r => firstString(r, ['midenNoteId'])).find(Boolean);
      if (get().flow === 'evm-to-miden' && discoveredNoteId && discoveredNoteId !== get().midenNoteId) {
        // Opportunistic: record the note id on the parked intent (and tag the
        // consume row if auto-consume already claimed it).
        resolveBridgeInNoteId(nonce, discoveredNoteId).catch(err =>
          console.warn('[epoch] resolveBridgeInNoteId failed', err)
        );
      }
      set({
        pollResults: results,
        midenNoteId: discoveredNoteId ?? get().midenNoteId,
        status: allDone ? 'done' : 'pending'
      });
    } catch (err) {
      console.error('[epoch] poll failed', err);
    }
  },

  reset() {
    set({ ...INITIAL_STATE });
  }
}));
