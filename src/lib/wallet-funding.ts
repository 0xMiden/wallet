import { useSyncExternalStore } from 'react';

import { completeWalletPrompt, faucet, WalletPromptType } from 'lib/wallet-prompts';

export type WalletFundingStatus = 'idle' | 'loading' | 'success' | 'failure';

export type WalletFundingState = {
  open: boolean;
  status: WalletFundingStatus;
  address: string | null;
  error: string | null;
};

const EMPTY_WALLET_FUNDING_STATE: WalletFundingState = {
  open: false,
  status: 'idle',
  address: null,
  error: null
};

let walletFundingState = EMPTY_WALLET_FUNDING_STATE;
let fundingPromise: Promise<void> | null = null;
let requestGeneration = 0;
const listeners = new Set<() => void>();

function publish(state: WalletFundingState): void {
  walletFundingState = state;
  listeners.forEach(listener => listener());
}

export function getWalletFundingState(): WalletFundingState {
  return walletFundingState;
}

export function subscribeToWalletFunding(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useWalletFunding(): WalletFundingState {
  return useSyncExternalStore(subscribeToWalletFunding, getWalletFundingState, getWalletFundingState);
}

/** Opens the drawer. Its mounted effect starts the request automatically. */
export function openWalletFunding(address: string): void {
  if (fundingPromise) {
    publish({ ...walletFundingState, open: true });
    return;
  }
  publish({ open: true, status: 'idle', address, error: null });
}

/** Hides only the UI; an in-flight faucet request continues at module scope. */
export function closeWalletFunding(): void {
  publish({ ...walletFundingState, open: false });
}

/**
 * Starts the request once the drawer mounts. Repeated mounts while a request is
 * running share the same promise, preventing duplicate faucet calls.
 */
export function startWalletFunding(): Promise<void> {
  if (fundingPromise) return fundingPromise;
  if (!walletFundingState.address || walletFundingState.status !== 'idle') return Promise.resolve();

  const address = walletFundingState.address;
  const generation = ++requestGeneration;
  publish({ ...walletFundingState, status: 'loading', error: null });

  const request = (async () => {
    try {
      await faucet(address);
    } catch (error) {
      if (generation !== requestGeneration) return;
      const message = error instanceof Error ? error.message : String(error);
      console.error('[wallet-funding] faucet request failed:', error);
      publish({ ...walletFundingState, status: 'failure', error: message });
      return;
    }

    if (generation !== requestGeneration) return;
    publish({ ...walletFundingState, status: 'success', error: null });
    try {
      await completeWalletPrompt(WalletPromptType.Faucet);
    } catch (error) {
      console.warn('[wallet-funding] failed to complete faucet prompt:', error);
    }
  })();

  fundingPromise = request;
  void request.finally(() => {
    if (fundingPromise === request) fundingPromise = null;
  });
  return request;
}

export function retryWalletFunding(): Promise<void> {
  if (!walletFundingState.address || fundingPromise) return fundingPromise ?? Promise.resolve();
  publish({ ...walletFundingState, status: 'idle', error: null });
  return startWalletFunding();
}

/** Test-only reset for the module-scoped lifecycle. */
export function _resetWalletFundingForTest(): void {
  requestGeneration += 1;
  fundingPromise = null;
  publish(EMPTY_WALLET_FUNDING_STATE);
}
