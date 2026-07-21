import { useCallback, useEffect, useState } from 'react';

import { findClaimableMidenToEvmDeposit } from 'lib/agglayer';
import { compareAccountIds } from 'lib/miden/activity/utils';
import {
  IBridgedReceiveExtraInputs,
  IBridgedSendExtraInputs,
  ITransaction,
  ITransactionStatus
} from 'lib/miden/db/types';
import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';
import * as Repo from 'lib/miden/repo';
import { updateBridgeClaimStatus } from 'lib/miden/transaction/complete';
import { mintFromMidenFaucet } from 'lib/miden-chain/faucet-api';

export enum WalletPromptType {
  Bridge = 'bridge',
  Faucet = 'faucet',
  VerifySeedPhrase = 'verifySeedPhrase',
  // Mobile-only: the native hot-key plugin could not use the device's secure
  // hardware (TEE / Secure Enclave), so transactions can't be signed. Surfaced
  // so the user can copy the raw native error and report it to us.
  HotKeyHardwareUnavailable = 'hotKeyHardwareUnavailable'
}

export enum WalletPromptStatus {
  Pending = 'pending',
  Dismissed = 'dismissed',
  Completed = 'completed'
}

export type WalletPromptStorage = {
  version: 1;
  prompts: Partial<Record<WalletPromptType, WalletPromptStatus>>;
};

export const WALLET_PROMPTS_STORAGE_KEY = 'wallet_prompts_v1';

export const EMPTY_WALLET_PROMPT_STORAGE: WalletPromptStorage = {
  version: 1,
  prompts: {}
};

const VALID_STATUSES = new Set<string>(Object.values(WalletPromptStatus));
const VALID_TYPES = new Set<string>(Object.values(WalletPromptType));

function isBridgePromptActive(tx: ITransaction): boolean {
  if (tx.status === ITransactionStatus.Failed) return false;
  if (tx.type === 'bridged-receive') {
    const phase = (tx.extraInputs as IBridgedReceiveExtraInputs).phase;
    return phase !== 'received' && phase !== 'failed';
  }
  if (tx.type !== 'bridged-send') return false;
  if (tx.status !== ITransactionStatus.Completed) return true;

  const inputs = tx.extraInputs as IBridgedSendExtraInputs;
  return inputs.provider === 'epoch'
    ? inputs.epochStatus !== 'confirmed' && inputs.epochStatus !== 'failed'
    : inputs.claimStatus !== 'claimed' && inputs.claimStatus !== 'failed';
}

export async function fetchActiveBridgePrompts(accountId: string): Promise<ITransaction[]> {
  const rows = await Repo.transactions
    .filter(
      tx => (tx.type === 'bridged-send' || tx.type === 'bridged-receive') && compareAccountIds(tx.accountId, accountId)
    )
    .toArray();
  return rows.filter(isBridgePromptActive).sort((left, right) => right.initiatedAt - left.initiatedAt);
}

async function pollBridgedSend(tx: ITransaction): Promise<void> {
  if (tx.type !== 'bridged-send' || tx.status !== ITransactionStatus.Completed) return;
  const inputs = tx.extraInputs as IBridgedSendExtraInputs;

  if (inputs.provider === 'agglayer') {
    if (inputs.claimStatus !== 'pending' || !inputs.destinationAddress) return;
    const deposit = await findClaimableMidenToEvmDeposit(inputs.destinationAddress);
    if (deposit) await updateBridgeClaimStatus(tx.id, 'ready', { depositReady: true });
    return;
  }

  if (
    inputs.epochStatus === 'confirmed' ||
    inputs.epochStatus === 'failed' ||
    !inputs.intentNonce ||
    !inputs.destinationAddress
  ) {
    return;
  }

  const { pollEpochIntentFill } = await import('lib/epoch');
  const fill = await pollEpochIntentFill({
    destinationAddress: inputs.destinationAddress,
    intentNonce: inputs.intentNonce
  });
  if (!fill || (!fill.fillTxHash && fill.status === 'pending')) return;
  await updateBridgeClaimStatus(tx.id, 'not-applicable', {
    epochStatus: fill.status,
    fillTxHash: fill.fillTxHash,
    fillChainId: fill.fillChainId
  });
}

export async function pollActiveBridgePrompts(transactions: ITransaction[]): Promise<void> {
  const { reconcileBridgedReceives } = await import('lib/miden/activity/bridge-receive');
  await Promise.all([
    transactions.some(tx => tx.type === 'bridged-receive') ? reconcileBridgedReceives() : Promise.resolve(),
    ...transactions.filter(tx => tx.type === 'bridged-send').map(pollBridgedSend)
  ]);
}

export function normalizeWalletPromptStorage(value: unknown): WalletPromptStorage {
  if (!value || typeof value !== 'object') {
    return EMPTY_WALLET_PROMPT_STORAGE;
  }

  const maybeStorage = value as Partial<WalletPromptStorage>;
  const prompts = maybeStorage.prompts && typeof maybeStorage.prompts === 'object' ? maybeStorage.prompts : {};

  return {
    version: 1,
    prompts: Object.entries(prompts).reduce<WalletPromptStorage['prompts']>((acc, [type, status]) => {
      if (VALID_TYPES.has(type) && typeof status === 'string' && VALID_STATUSES.has(status)) {
        acc[type as WalletPromptType] = status as WalletPromptStatus;
      }
      return acc;
    }, {})
  };
}

export function isWalletPromptPending(storage: WalletPromptStorage, type: WalletPromptType): boolean {
  return storage.prompts[type] === WalletPromptStatus.Pending;
}

export async function fetchWalletPromptStorage(): Promise<WalletPromptStorage> {
  return normalizeWalletPromptStorage(await fetchFromStorage(WALLET_PROMPTS_STORAGE_KEY));
}

async function putWalletPromptStorage(storage: WalletPromptStorage): Promise<WalletPromptStorage> {
  await putToStorage(WALLET_PROMPTS_STORAGE_KEY, storage);
  return storage;
}

export async function setWalletPromptStatus(
  type: WalletPromptType,
  status: WalletPromptStatus
): Promise<WalletPromptStorage> {
  const storage = await fetchWalletPromptStorage();
  return putWalletPromptStorage({
    version: 1,
    prompts: {
      ...storage.prompts,
      [type]: status
    }
  });
}

export async function seedWalletPrompt(type: WalletPromptType): Promise<WalletPromptStorage> {
  const storage = await fetchWalletPromptStorage();
  const currentStatus = storage.prompts[type];
  if (currentStatus === WalletPromptStatus.Dismissed || currentStatus === WalletPromptStatus.Completed) {
    return storage;
  }

  return putWalletPromptStorage({
    version: 1,
    prompts: {
      ...storage.prompts,
      [type]: WalletPromptStatus.Pending
    }
  });
}

export const dismissWalletPrompt = (type: WalletPromptType) =>
  setWalletPromptStatus(type, WalletPromptStatus.Dismissed);

export const completeWalletPrompt = (type: WalletPromptType) =>
  setWalletPromptStatus(type, WalletPromptStatus.Completed);

// -- Hot-key hardware failure report --------------------------------------
//
// When native hot-key signing fails because the device's secure hardware is
// unusable, we stash the raw native error string alongside seeding the
// HotKeyHardwareUnavailable prompt, so the prompt's "Copy error" action has
// something concrete to hand back to us. Kept in its own storage key rather
// than on WalletPromptStorage so the prompt-status shape stays a plain
// type→status map.

export const HOT_KEY_HARDWARE_ERROR_STORAGE_KEY = 'hot_key_hardware_error_v1';

export type HotKeyHardwareErrorRecord = {
  message: string;
};

export async function fetchHotKeyHardwareError(): Promise<HotKeyHardwareErrorRecord | null> {
  const raw = await fetchFromStorage(HOT_KEY_HARDWARE_ERROR_STORAGE_KEY);
  if (!raw || typeof raw !== 'object') return null;
  const message = Reflect.get(raw, 'message');
  return typeof message === 'string' ? { message } : null;
}

/**
 * Record a native hot-key hardware failure and surface the report prompt.
 * Called (via a lazy import) from the secure-hot-key facade on mobile when a
 * native op rejects with the HARDWARE_UNAVAILABLE code. `seedWalletPrompt`
 * respects an earlier dismiss/complete, so we don't re-nag a user who already
 * acknowledged it.
 */
export async function reportHotKeyHardwareFailure(message: string): Promise<void> {
  await putToStorage(HOT_KEY_HARDWARE_ERROR_STORAGE_KEY, { message });
  await seedWalletPrompt(WalletPromptType.HotKeyHardwareUnavailable);
}

const FAUCET_API_URL = 'https://faucet-api.forkchoice.xyz/api/mint';
// 10 IMIDEN in base units (8 decimals).
const IMIDEN_FAUCET_AMOUNT = 1_000_000_000;
// 100 MIDEN in base units (6 decimals).
const MIDEN_FAUCET_AMOUNT = 100_000_000n;

async function mintFromForkchoice(address: string): Promise<void> {
  const response = await fetch(FAUCET_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      token: 'IMIDEN',
      address,
      amount: IMIDEN_FAUCET_AMOUNT,
      note_type: 'public'
    })
  });

  if (!response.ok) {
    throw new Error(`Faucet request failed with status ${response.status}`);
  }
}

export async function faucet(address: string): Promise<void> {
  await Promise.all([mintFromForkchoice(address), mintFromMidenFaucet(address, MIDEN_FAUCET_AMOUNT)]);
}

export function useWalletPromptStorage() {
  const [storage, setStorage] = useState<WalletPromptStorage>(EMPTY_WALLET_PROMPT_STORAGE);
  const [isLoaded, setIsLoaded] = useState(false);

  const refreshPrompts = useCallback(async () => {
    const nextStorage = await fetchWalletPromptStorage();
    setStorage(nextStorage);
    setIsLoaded(true);
    return nextStorage;
  }, []);

  useEffect(() => {
    let cancelled = false;

    fetchWalletPromptStorage()
      .then(nextStorage => {
        if (!cancelled) {
          setStorage(nextStorage);
          setIsLoaded(true);
        }
      })
      .catch(error => {
        console.warn('[wallet-prompts] failed to refresh prompts:', error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const setPromptStatus = useCallback(
    (type: WalletPromptType, status: WalletPromptStatus) => {
      setStorage(prev => {
        const current = normalizeWalletPromptStorage(prev);
        const next: WalletPromptStorage = {
          version: 1,
          prompts: {
            ...current.prompts,
            [type]: status
          }
        };
        putWalletPromptStorage(next).catch(error => {
          console.warn('[wallet-prompts] failed to persist prompt status:', error);
          refreshPrompts();
        });
        return next;
      });
    },
    [refreshPrompts]
  );

  const dismissPrompt = useCallback(
    (type: WalletPromptType) => setPromptStatus(type, WalletPromptStatus.Dismissed),
    [setPromptStatus]
  );

  const completePrompt = useCallback(
    (type: WalletPromptType) => setPromptStatus(type, WalletPromptStatus.Completed),
    [setPromptStatus]
  );

  const isPromptPending = useCallback((type: WalletPromptType) => isWalletPromptPending(storage, type), [storage]);

  return {
    storage,
    isLoaded,
    refreshPrompts,
    setPromptStatus,
    dismissPrompt,
    completePrompt,
    isPromptPending
  };
}
