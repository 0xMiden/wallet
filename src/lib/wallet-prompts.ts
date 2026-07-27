import { useCallback, useEffect, useState } from 'react';

import BigNumber from 'bignumber.js';

import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';
import type { AssetMetadata } from 'lib/miden/metadata';
import type { ConsumableNote } from 'lib/miden/types';
import { mintFromMidenFaucet } from 'lib/miden-chain/faucet-api';
import { getTokenPrice } from 'lib/prices';
import type { TokenPrices } from 'lib/prices';

export enum WalletPromptType {
  Faucet = 'faucet',
  PendingNotes = 'pendingNotes',
  VerifySeedPhrase = 'verifySeedPhrase'
}

export enum WalletPromptStatus {
  Pending = 'pending',
  Dismissed = 'dismissed',
  Completed = 'completed'
}

export type WalletPromptStorage = {
  version: 1;
  prompts: Partial<Record<WalletPromptType, WalletPromptStatus>>;
  pendingNotesDismissedIds: string[];
};

export const WALLET_PROMPTS_STORAGE_KEY = 'wallet_prompts_v1';

export const EMPTY_WALLET_PROMPT_STORAGE: WalletPromptStorage = {
  version: 1,
  prompts: {},
  pendingNotesDismissedIds: []
};

export type PendingNoteValue = Pick<ConsumableNote, 'id' | 'amount'> & {
  metadata: Pick<AssetMetadata, 'decimals' | 'symbol'>;
};

const VALID_STATUSES = new Set<string>(Object.values(WalletPromptStatus));
const VALID_TYPES = new Set<string>(Object.values(WalletPromptType));

function normalizePendingNotesDismissedIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0)));
}

export function getPendingNotesUsdTotal(notes: readonly PendingNoteValue[], tokenPrices: TokenPrices): number {
  return notes.reduce((total, note) => {
    // `amount` is a base-units bigint string; BigNumber keeps full integer
    // precision where Number(amount) would silently round above 2^53.
    const amount = new BigNumber(note.amount).shiftedBy(-note.metadata.decimals).toNumber();
    const { price } = getTokenPrice(tokenPrices, note.metadata.symbol);
    return total + amount * price;
  }, 0);
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
    }, {}),
    pendingNotesDismissedIds: normalizePendingNotesDismissedIds(Reflect.get(value, 'pendingNotesDismissedIds'))
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
    },
    pendingNotesDismissedIds: storage.pendingNotesDismissedIds
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
    },
    pendingNotesDismissedIds: storage.pendingNotesDismissedIds
  });
}

export const dismissWalletPrompt = (type: WalletPromptType) =>
  setWalletPromptStatus(type, WalletPromptStatus.Dismissed);

export const completeWalletPrompt = (type: WalletPromptType) =>
  setWalletPromptStatus(type, WalletPromptStatus.Completed);

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
    (type: WalletPromptType, status: WalletPromptStatus, dismissedNoteIds?: readonly string[]) => {
      setStorage(prev => {
        const current = normalizeWalletPromptStorage(prev);
        const next: WalletPromptStorage = {
          version: 1,
          prompts: {
            ...current.prompts,
            [type]: status
          },
          pendingNotesDismissedIds:
            dismissedNoteIds === undefined
              ? current.pendingNotesDismissedIds
              : normalizePendingNotesDismissedIds(dismissedNoteIds)
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
