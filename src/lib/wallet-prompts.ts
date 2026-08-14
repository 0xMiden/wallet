import { useCallback, useEffect, useState } from 'react';

import BigNumber from 'bignumber.js';

import { findClaimableMidenToEvmDeposit } from 'lib/agglayer';
import { compareAccountIds } from 'lib/miden/activity/utils';
import { IBridgedSendExtraInputs, ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';
import type { AssetMetadata } from 'lib/miden/metadata';
import * as Repo from 'lib/miden/repo';
import { updateBridgeClaimStatus } from 'lib/miden/transaction/complete';
import type { ConsumableNote } from 'lib/miden/types';
import { faucetFetch, mintFromMidenFaucet } from 'lib/miden-chain/faucet-api';
import { getTokenPrice } from 'lib/prices';
import type { TokenPrices } from 'lib/prices';

export enum WalletPromptType {
  Bridge = 'bridge',
  Faucet = 'faucet',
  PendingNotes = 'pendingNotes',
  VerifySeedPhrase = 'verifySeedPhrase',
  // Mobile-only: the native hot-key plugin hit a secure-hardware error —
  // either it couldn't use the TEE / Secure Enclave at all (signing falls back
  // to the software key), or a present StrongBox failed and the key degraded
  // to TEE (Android, signing still hardware-backed). Surfaced so the user can
  // copy the raw native error and report it to us.
  HotKeyHardwareUnavailable = 'hotKeyHardwareUnavailable',
  // Mobile-only: the native hot-key plugin rejected with UNWRAP_FAILED /
  // KEY_INVALIDATED — the hardware-wrapped key blob can no longer be
  // decrypted (e.g. an OS upgrade dropped an OAEP authorization, or the OS
  // invalidated a legacy auth-bound key). The remedy is a hot-key rotation,
  // so the prompt's action initiates a replace-hot-key transaction.
  HotKeyRotationNeeded = 'hotKeyRotationNeeded'
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

function isBridgePromptActive(tx: ITransaction): boolean {
  if (tx.status === ITransactionStatus.Failed) return false;
  if (tx.type !== 'bridged-send') return false;
  if (tx.status !== ITransactionStatus.Completed) return true;

  const inputs = tx.extraInputs as IBridgedSendExtraInputs;
  return inputs.provider === 'epoch'
    ? inputs.epochStatus !== 'confirmed' && inputs.epochStatus !== 'failed'
    : inputs.claimStatus !== 'claimed' && inputs.claimStatus !== 'failed';
}

export async function fetchActiveBridgePrompts(accountId: string): Promise<ITransaction[]> {
  const rows = await Repo.transactions
    .filter(tx => tx.type === 'bridged-send' && compareAccountIds(tx.accountId, accountId))
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
  await Promise.all(transactions.filter(tx => tx.type === 'bridged-send').map(pollBridgedSend));
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

/**
 * Surface the "rotate your device key" prompt. Called (via a lazy import)
 * from the secure-hot-key facade when a native op rejects with UNWRAP_FAILED
 * or KEY_INVALIDATED. Unlike `seedWalletPrompt`, a COMPLETED status re-arms:
 * a fresh unwrap failure after a successful rotation is a new incident, not
 * the one the user already resolved. An explicit dismiss stays sticky, and an
 * already-pending prompt skips the write — guardian autosync retries signing
 * every few seconds, so this is called in a tight loop while the key is broken.
 */
export async function reportHotKeyRotationNeeded(): Promise<void> {
  const storage = await fetchWalletPromptStorage();
  const status = storage.prompts[WalletPromptType.HotKeyRotationNeeded];
  if (status === WalletPromptStatus.Dismissed || status === WalletPromptStatus.Pending) return;
  await setWalletPromptStatus(WalletPromptType.HotKeyRotationNeeded, WalletPromptStatus.Pending);
}

const FAUCET_API_URL = 'https://faucet-api.forkchoice.xyz/api/mint';
// 10 IMIDEN in base units (8 decimals).
const IMIDEN_FAUCET_AMOUNT = 1_000_000_000;
// 100 MIDEN in base units (6 decimals).
const MIDEN_FAUCET_AMOUNT = 100_000_000n;

async function mintFromForkchoice(address: string): Promise<void> {
  // `faucetFetch` bounds the request with a timeout and honors a 429 Retry-After,
  // so a wedged or rate-limited forkchoice faucet fails cleanly instead of
  // hanging the funding flow.
  const response = await faucetFetch(FAUCET_API_URL, {
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

/**
 * Aggregated faucet failure. `faucet()` fans out to two independent sources
 * (forkchoice IMIDEN + official MIDEN); ANY rejection surfaces here with a
 * message that names which source(s) failed and their underlying error text,
 * so the funding drawer can show the real reason rather than a generic string.
 */
export class FaucetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FaucetError';
  }
}

function reasonMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

type FaucetSource = 'forkchoice' | 'miden';

/**
 * Per-address record of which faucet SOURCES have already paid out, so a Retry
 * after a partial failure re-mints ONLY the source that actually failed.
 *
 * Without this, `faucet()` re-ran BOTH sources on every call: if forkchoice
 * succeeded but MIDEN failed, tapping Retry minted forkchoice a SECOND time
 * (double-funding the source that already worked) while retrying MIDEN. The memo
 * is cleared once BOTH sources have succeeded, so a genuine later re-fund starts
 * fresh rather than being skipped forever.
 */
const succeededFaucetSources = new Map<string, Set<FaucetSource>>();

/** Test-only: clear the per-address faucet-source progress between cases. */
export function __resetFaucetProgressForTest(): void {
  succeededFaucetSources.clear();
}

export async function faucet(address: string): Promise<void> {
  const done = succeededFaucetSources.get(address) ?? new Set<FaucetSource>();

  const sources: Array<{ source: FaucetSource; label: string; run: () => Promise<unknown> }> = [
    { source: 'forkchoice', label: 'IMIDEN', run: () => mintFromForkchoice(address) },
    { source: 'miden', label: 'MIDEN', run: () => mintFromMidenFaucet(address, MIDEN_FAUCET_AMOUNT) }
  ];
  const pending = sources.filter(source => !done.has(source.source));

  // Both sources already funded this address in a prior (partial) attempt —
  // nothing to re-mint. Clear the memo and report success.
  if (pending.length === 0) {
    succeededFaucetSources.delete(address);
    return;
  }

  const results = await Promise.allSettled(pending.map(source => source.run()));

  const failures: string[] = [];
  pending.forEach((source, i) => {
    const result = results[i];
    if (!result) return;
    if (result.status === 'fulfilled') {
      done.add(source.source);
    } else {
      failures.push(`${source.label}: ${reasonMessage(result.reason)}`);
    }
  });

  if (failures.length > 0) {
    // Remember the sources that DID pay out, so Retry skips them.
    succeededFaucetSources.set(address, done);
    throw new FaucetError(failures.join('; '));
  }

  // Fully funded — forget the address so a future re-fund isn't skipped.
  succeededFaucetSources.delete(address);
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
