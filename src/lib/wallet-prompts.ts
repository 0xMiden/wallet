import { useCallback, useEffect, useRef, useState } from 'react';

import BigNumber from 'bignumber.js';

import { findClaimableMidenToEvmDeposit } from 'lib/agglayer';
import {
  fetchGuardianNoteRecoveryProgress,
  GUARDIAN_NOTE_RECOVERY_PROGRESS_STORAGE_KEY,
  type GuardianNoteRecoveryProgress,
  isGuardianNoteRecoveryProgressStale,
  normalizeGuardianNoteRecoveryProgress
} from 'lib/guardian-note-recovery-progress';
import { compareAccountIds } from 'lib/miden/activity/utils';
import { IBridgedSendExtraInputs, ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import { fetchFromStorage, onStorageChanged, putToStorage } from 'lib/miden/front/storage';
import type { AssetMetadata } from 'lib/miden/metadata';
import * as Repo from 'lib/miden/repo';
import { updateBridgeClaimStatus } from 'lib/miden/transaction/complete';
import type { ConsumableNote } from 'lib/miden/types';
import { FaucetOutcomeUnknownError, mintFromMidenFaucet } from 'lib/miden-chain/faucet-api';
import { getTokenPrice } from 'lib/prices';
import type { TokenPrices } from 'lib/prices';

export enum WalletPromptType {
  Bridge = 'bridge',
  Faucet = 'faucet',
  PendingNotes = 'pendingNotes',
  VerifySeedPhrase = 'verifySeedPhrase',
  // Non-dismissible, live-progress card shown while the post-seed-recovery
  // pending-note scan runs. Driven purely by the progress record the SW
  // orchestrator writes (lib/guardian-note-recovery-progress), NOT by the
  // persisted prompt-status map — it appears when a record exists and
  // disappears when the scan clears it.
  GuardianNoteRecovery = 'guardianNoteRecovery',
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

// Every prompt type whose status is kept once for the whole wallet. The faucet prompt's
// status is kept per account (`faucetByAccount`), so it has no wallet-wide entry.
export type WalletWidePromptType = Exclude<WalletPromptType, WalletPromptType.Faucet>;

export type WalletPromptStorage = {
  version: 1;
  prompts: Partial<Record<WalletWidePromptType, WalletPromptStatus>>;
  pendingNotesDismissedIds: string[];
  // The faucet prompt is about one account's balance, so its status is kept per
  // account address. A wallet-wide status let one account's completion or dismiss
  // hide Fund on every other account (#921). Any `prompts.faucet` left by an older
  // build is ignored: the card only ever shows on an unfunded account, so offering
  // it once more is the safe direction.
  faucetByAccount: Record<string, WalletPromptStatus>;
};

export const WALLET_PROMPTS_STORAGE_KEY = 'wallet_prompts_v1';

export const EMPTY_WALLET_PROMPT_STORAGE: WalletPromptStorage = {
  version: 1,
  prompts: {},
  pendingNotesDismissedIds: [],
  faucetByAccount: {}
};

export type PendingNoteValue = Pick<ConsumableNote, 'id' | 'amount' | 'faucetId'> & {
  metadata: Pick<AssetMetadata, 'decimals' | 'symbol'>;
};

const VALID_STATUSES = new Set<string>(Object.values(WalletPromptStatus));
const VALID_TYPES = new Set<string>(Object.values(WalletPromptType).filter(type => type !== WalletPromptType.Faucet));

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
  // A restored row still DISPLAYS whatever the backup recorded, deliberately,
  // but it must not drive work: this prompt surfaces a Claim affordance that
  // signs an EVM transaction.
  if (tx.restoredFromBackup) return false;
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
    // Bound to this row's own Miden transaction id: several rows can share one
    // destination address, and marking them all ready off ANY claimable deposit
    // points every one of them at the same deposit.
    const deposit = await findClaimableMidenToEvmDeposit(inputs.destinationAddress, tx.transactionId);
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

/**
 * Poll every Miden→EVM bridge row once, for every account. The app-root
 * `BridgeIntentWatcher` runs this on an interval, so a pending Epoch fill or
 * AggLayer claim is tracked whichever screen is open. `pollBridgedSend` returns
 * early for a row with nothing left to settle.
 */
export async function reconcileBridgedSends(): Promise<void> {
  const rows = await Repo.transactions.filter(tx => tx.type === 'bridged-send').toArray();
  // A restored row keeps what the backup recorded, but must not drive work:
  // `pollBridgedSend` queries the bridge services with those values and writes
  // the answer back onto the row.
  await Promise.all(
    rows
      .filter(tx => !tx.restoredFromBackup)
      .map(tx =>
        // One row's failing indexer or allocator call must not reject the pass for the others.
        pollBridgedSend(tx).catch(error => console.warn('[wallet-prompts] bridged-send poll failed', tx.id, error))
      )
  );
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
        acc[type as WalletWidePromptType] = status as WalletPromptStatus;
      }
      return acc;
    }, {}),
    pendingNotesDismissedIds: normalizePendingNotesDismissedIds(Reflect.get(value, 'pendingNotesDismissedIds')),
    faucetByAccount: normalizeFaucetByAccount(Reflect.get(value, 'faucetByAccount'))
  };
}

function normalizeFaucetByAccount(value: unknown): Record<string, WalletPromptStatus> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.entries(value).reduce<Record<string, WalletPromptStatus>>((acc, [address, status]) => {
    if (address && typeof status === 'string' && VALID_STATUSES.has(status)) {
      acc[address] = status as WalletPromptStatus;
    }
    return acc;
  }, {});
}

export function isWalletPromptPending(storage: WalletPromptStorage, type: WalletWidePromptType): boolean {
  return storage.prompts[type] === WalletPromptStatus.Pending;
}

export async function fetchWalletPromptStorage(): Promise<WalletPromptStorage> {
  return normalizeWalletPromptStorage(await fetchFromStorage(WALLET_PROMPTS_STORAGE_KEY));
}

// Writers own different fields of one record (a prompt's status, the dismissed note
// ids, each account's faucet status), so every write applies its change to the record
// as it is now, one operation at a time. A writer building on a copy read before another
// writer's put would store the old value of every field it does not own. The hook's own
// reads take their turn too, so a load never lands after a write it predates.
// The turn is a Web Lock, which the extension's popup, side panel, tabs and service worker
// share, so a surface cannot put back a field another surface just changed.
// There is no timeout on a turn: a write already sent to storage cannot be called back,
// so starting the next one early would let the slow one land over it.
function inWalletPromptStorageTurn<T>(operation: () => Promise<T>): Promise<T> {
  return navigator.locks.request<Promise<T>>(`turn:${WALLET_PROMPTS_STORAGE_KEY}`, operation);
}

function updateWalletPromptStorage(
  change: (current: WalletPromptStorage) => WalletPromptStorage
): Promise<WalletPromptStorage> {
  return inWalletPromptStorageTurn(async () => {
    const current = await fetchWalletPromptStorage();
    const next = change(current);
    // A change that keeps the record as it is (seeding a prompt already settled) writes nothing.
    if (next !== current) await putToStorage(WALLET_PROMPTS_STORAGE_KEY, next);
    return next;
  });
}

export function setWalletPromptStatus(
  type: WalletWidePromptType,
  status: WalletPromptStatus
): Promise<WalletPromptStorage> {
  return updateWalletPromptStorage(storage => ({ ...storage, prompts: { ...storage.prompts, [type]: status } }));
}

export function seedWalletPrompt(type: WalletWidePromptType): Promise<WalletPromptStorage> {
  return updateWalletPromptStorage(storage => {
    const currentStatus = storage.prompts[type];
    if (currentStatus === WalletPromptStatus.Dismissed || currentStatus === WalletPromptStatus.Completed) {
      return storage;
    }
    return { ...storage, prompts: { ...storage.prompts, [type]: WalletPromptStatus.Pending } };
  });
}

export const dismissWalletPrompt = (type: WalletWidePromptType) =>
  setWalletPromptStatus(type, WalletPromptStatus.Dismissed);

export const completeWalletPrompt = (type: WalletWidePromptType) =>
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
  // Decided in its own storage turn, so a completion queued just before this report is seen.
  await updateWalletPromptStorage(storage => {
    const status = storage.prompts[WalletPromptType.HotKeyRotationNeeded];
    if (status === WalletPromptStatus.Dismissed || status === WalletPromptStatus.Pending) return storage;
    return {
      ...storage,
      prompts: { ...storage.prompts, [WalletPromptType.HotKeyRotationNeeded]: WalletPromptStatus.Pending }
    };
  });
}

// -- Faucet funding-in-flight marker ---------------------------------------
//
// Stamped when a faucet request is accepted and cleared when the funds become
// visible (or the wait times out). Persisted per account — one account's wait
// must never surface on another — so the Home prompt can resume that
// account's "Funding" presentation after a remount or app restart mid-wait.
// `baselineNoteIds` records the claimable notes that already existed at
// request time: arrival requires a note NOT in this set (or a balance), so a
// pre-existing unclaimed note can't fake an instant success. `submitted` is set
// just before the token request goes out: without it nothing can have been
// minted, so a marker with no request left running is abandoned rather than a
// mint still on its way.

export type FaucetFundingMarker = {
  requestedAt: number;
  baselineNoteIds: readonly string[];
  submitted?: true;
  // When the token request went out, stored with the flag: a request held back for
  // minutes before sending is judged from here, not from when it was asked for.
  submittedAt?: number;
};

const faucetFundingMarkerKey = (address: string) => `faucet_funding_v2:${address}`;

export async function fetchFaucetFundingMarker(address: string): Promise<FaucetFundingMarker | null> {
  const raw = await fetchFromStorage(faucetFundingMarkerKey(address));
  if (!raw || typeof raw !== 'object') return null;
  const requestedAt = Reflect.get(raw, 'requestedAt');
  const baselineNoteIds = Reflect.get(raw, 'baselineNoteIds');
  if (typeof requestedAt !== 'number' || !Number.isFinite(requestedAt)) return null;
  // A persisted wall-clock stamp is untrusted input: a forward clock step (NTP,
  // a manual change) leaves a stamp in the future, which reads as "always
  // fresh" and would wedge the wait past its own timeout.
  if (requestedAt > Date.now()) return null;
  if (!Array.isArray(baselineNoteIds)) return null;
  const marker: FaucetFundingMarker = {
    requestedAt,
    baselineNoteIds: baselineNoteIds.filter((id): id is string => typeof id === 'string')
  };
  // Any stored value reads as submitted: erring the other way would clear a marker
  // for a mint that could still land.
  if (Reflect.get(raw, 'submitted') !== undefined) marker.submitted = true;
  // Untrusted like requestedAt; an unusable send time falls back to the request time.
  const submittedAt = Reflect.get(raw, 'submittedAt');
  if (
    typeof submittedAt === 'number' &&
    Number.isFinite(submittedAt) &&
    submittedAt >= requestedAt &&
    submittedAt <= Date.now()
  ) {
    marker.submittedAt = submittedAt;
  }
  return marker;
}

/**
 * Runs `operation` holding the funding-marker lock for `address`. Every read of the marker that
 * decides a write to it runs under this lock: navigator.locks is shared by the extension's popup,
 * side panel, tabs and service worker, so two surfaces can no longer both find no live marker and
 * both send.
 */
export function withFaucetFundingMarkerLock(address: string, operation: () => Promise<void>): Promise<void> {
  return navigator.locks.request(`faucet-funding-marker:${address}`, operation);
}

export async function setFaucetFundingMarker(address: string, marker: FaucetFundingMarker | null): Promise<void> {
  await putToStorage(faucetFundingMarkerKey(address), marker);
}

// 100 MIDEN in base units (6 decimals).
const MIDEN_FAUCET_AMOUNT = 100_000_000n;
// Bail out of a hung faucet request. The timeout also aborts the underlying
// work: the signal is linked into each fetch and checked per PoW iteration.
// (A 429 back-off sleep inside faucetFetch is not itself interrupted, so
// cancellation of the work can lag the wrapper's rejection by up to that
// capped wait — the next fetch attempt then aborts immediately.)
const FAUCET_REQUEST_TIMEOUT_MS = 60_000;
/**
 * How long a funding marker not flagged `submitted` may still belong to a live
 * request, in this surface or another one sharing storage (the extension popup, side
 * panel and tabs each run their own requests). Past its request's timeout the work
 * was aborted before any token request, so the marker is abandoned. The grace covers
 * the request starting a moment after the marker's `requestedAt`.
 */
export const FAUCET_UNSUBMITTED_MARKER_MS = FAUCET_REQUEST_TIMEOUT_MS + 5_000;
/**
 * How long after a request went out a surface keeps showing the "Funding" wait before
 * giving the Fund action back. Arrival normally takes ~30-60s (chain inclusion + client sync).
 */
export const FAUCET_FUNDS_ARRIVAL_TIMEOUT_MS = 3 * 60_000;

/**
 * Whether a stored marker may still stand for a mint on its way, so a surface waits for
 * it rather than offering Fund. While a request still runs in this realm (`runningHere`:
 * held back, as in a backgrounded app) it has not settled, so its window has not started.
 * Otherwise a marker not flagged submitted is abandoned once its request's timeout has
 * certainly passed, and a flagged one waits out the arrival window from when it went out.
 */
export function isFaucetFundingMarkerLive(
  marker: FaucetFundingMarker,
  { runningHere, settledAt }: { runningHere: boolean; settledAt: number | null }
): boolean {
  if (runningHere) return true;
  const now = Date.now();
  if (!marker.submitted) return now - marker.requestedAt < FAUCET_UNSUBMITTED_MARKER_MS;
  return now - faucetArrivalWindowStart(marker, settledAt) < FAUCET_FUNDS_ARRIVAL_TIMEOUT_MS;
}

/** Where a sent request's arrival window starts: its settle as this realm saw it, else when it went out. */
export function faucetArrivalWindowStart(marker: FaucetFundingMarker, settledAt: number | null | undefined): number {
  return settledAt ?? marker.submittedAt ?? marker.requestedAt;
}

/** A request refused because another request for the account is still live; `marker` is that request's. */
export class FaucetRequestInProgressError extends Error {
  readonly marker: FaucetFundingMarker;

  constructor(marker: FaucetFundingMarker) {
    super('Another faucet request for this account is still running');
    this.name = 'FaucetRequestInProgressError';
    this.marker = marker;
  }
}

async function runFaucetRequest(address: string, marker?: FaucetFundingMarker): Promise<void> {
  const controller = new AbortController();
  let submitted = false;
  // Set once the submitted flag is being stored: from then on the flag may land, and every
  // surface would read the request as sent.
  let flagging = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The race guarantees the wrapper rejects on time even if the underlying
  // work fails to observe the abort promptly.
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Once the token request is out, a timeout says nothing about whether the
      // faucet minted - so it must not read as a refusal a retry can safely follow.
      const timeoutError = submitted
        ? new FaucetOutcomeUnknownError('Faucet request timed out after the token request was sent')
        : flagging
          ? new FaucetOutcomeUnknownError('Faucet request timed out while it was being marked sent')
          : new Error('Faucet request timed out');
      controller.abort(timeoutError);
      reject(timeoutError);
    }, FAUCET_REQUEST_TIMEOUT_MS);
  });
  const work = (async () => {
    if (marker) {
      await withFaucetFundingMarkerLock(address, async () => {
        // Another surface's request may already be minting: a surface that read no marker
        // before that tap still offers Fund, and overwriting its marker would let this one
        // pass its own check below and mint again. Nothing of that request runs here.
        const stored = await fetchFaucetFundingMarker(address);
        if (
          stored !== null &&
          stored.requestedAt !== marker.requestedAt &&
          isFaucetFundingMarkerLive(stored, {
            runningHere: false,
            settledAt: getFaucetRequestSettledAt(address, stored.requestedAt)
          })
        ) {
          throw new FaucetRequestInProgressError(stored);
        }
        // A request its timeout already ended reported a safe failure and writes nothing: a
        // retry may have stored its own marker by now.
        if (controller.signal.aborted) throw controller.signal.reason;
        // Not best effort: the pre-send check needs this request's marker stored, so a request
        // that cannot store it fails here, before the proof of work.
        await setFaucetFundingMarker(address, marker);
      });
    }
    return mintFromMidenFaucet(
      address,
      MIDEN_FAUCET_AMOUNT,
      controller.signal,
      async () => {
        if (marker) {
          await withFaucetFundingMarkerLock(address, async () => {
            // Another surface ends an unflagged marker as abandoned once its request timeout
            // has passed; if this realm's timers were held back that long, the request is
            // over as far as every surface knows, and sending now could mint twice.
            const stored = await fetchFaucetFundingMarker(address);
            if (stored?.requestedAt !== marker.requestedAt) {
              throw new Error('Faucet request was ended before it was sent');
            }
            // A request its timeout already ended reported a safe failure: flag nothing.
            if (controller.signal.aborted) throw controller.signal.reason;
            // Not best effort: a marker without the flag is cleared as abandoned once no
            // request runs in its realm. If the flag cannot be stored, fail here, while
            // nothing can have been minted and a retry is still safe.
            flagging = true;
            await setFaucetFundingMarker(address, { ...marker, submitted: true, submittedAt: Date.now() });
            flagging = false;
          });
        }
        submitted = true;
      },
      mayMint => {
        // A refusal status means no mint is on its way, whatever the flag says.
        submitted = mayMint;
      }
    );
  })();
  try {
    await Promise.race([work, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

// One request per address at a time, held at MODULE scope. A component-local
// guard is not enough: HomePrompts unmounts whenever Home itself is left for a
// route the tab layout does not keep mounted, and it is remounted fresh on the
// next visit, so a returning user could start a second real mint. Module scope
// also lets the remounted card re-attach to the outcome. Keyed per address so
// funding one account never blocks funding another.
const inFlightFaucetRequests = new Map<string, { request: Promise<void>; marker?: FaucetFundingMarker }>();

/** The in-flight faucet request for `address`, if any — lets a remounted card re-attach to the outcome. */
export function getInFlightFaucetRequest(address: string): Promise<void> | null {
  return inFlightFaucetRequests.get(address)?.request ?? null;
}

/** The marker the in-flight request for `address` was started with, so a remounted card can wait for its mint without reading storage. */
export function getInFlightFaucetMarker(address: string): FaucetFundingMarker | null {
  return inFlightFaucetRequests.get(address)?.marker ?? null;
}

// When this realm saw each account's latest request go out (accepted, or never
// answered), keyed to that request's `requestedAt`. The wait for its mint runs from
// here: a request can settle long after it was asked for when the app was away.
const settledFaucetRequests = new Map<string, { requestedAt: number; settledAt: number }>();

/** When this realm saw the request `requestedAt` for `address` go out, if it did. */
export function getFaucetRequestSettledAt(address: string, requestedAt: number): number | null {
  const settled = settledFaucetRequests.get(address);
  return settled?.requestedAt === requestedAt ? settled.settledAt : null;
}

/**
 * Requests test tokens for `address`, or joins the request already running for it.
 * Given a `marker`, the request persists it and flags it submitted before the token
 * request goes out, so a later open can tell a mint that may land from one that
 * never went out.
 */
export function faucet(address: string, marker?: FaucetFundingMarker): Promise<void> {
  const existing = inFlightFaucetRequests.get(address);
  if (existing) return existing.request;
  const recordSettled = () => {
    if (marker) settledFaucetRequests.set(address, { requestedAt: marker.requestedAt, settledAt: Date.now() });
  };
  // Storage reads settle asynchronously, so a reader of the marker always finds
  // this request registered by the `set` below. A joiner's marker is ignored: the
  // request it joins already persists its own.
  const request: Promise<void> = runFaucetRequest(address, marker)
    .then(recordSettled, (error: unknown) => {
      if (error instanceof FaucetOutcomeUnknownError) recordSettled();
      throw error;
    })
    .finally(() => {
      if (inFlightFaucetRequests.get(address)?.request === request) inFlightFaucetRequests.delete(address);
    });
  inFlightFaucetRequests.set(address, { request, marker });
  return request;
}

/** Test-only: drop in-flight faucet joins and remembered settles between cases. */
export function __resetInFlightFaucetRequestsForTest(): void {
  inFlightFaucetRequests.clear();
  settledFaucetRequests.clear();
}

/**
 * Live progress of the post-seed-recovery pending-note scan, or null when no
 * scan is running. Extension surfaces get push updates via storage change
 * events (the SW writes through the same storage area); mobile/desktop have no
 * storage events, so a light poll keeps the card advancing there too.
 *
 * Pass the viewed account's id only while its `guardianNoteRecoveryPending`
 * flag is set, and null otherwise. That gate is the whole reason this hook can
 * be cheap: only a pending account can have a run to narrate, and the flag is
 * cleared strictly after the progress record is, so gating on it can never hide
 * a live card. Every other wallet — nearly all of them, nearly always — does no
 * reads at all.
 *
 * Records are stored per account, so a run for a different recovered account
 * cannot narrate itself on this account's home view.
 */
export function useGuardianNoteRecoveryProgress(accountId: string | null): GuardianNoteRecoveryProgress | null {
  const [progress, setProgress] = useState<GuardianNoteRecoveryProgress | null>(null);
  const cancelledRef = useRef(false);

  // A run that died with its realm stops refreshing the record. The card is
  // non-dismissible, so without ageing the record out it would sit on screen
  // forever.
  const accept = useCallback((next: GuardianNoteRecoveryProgress | null) => {
    if (cancelledRef.current) return;
    setProgress(next && isGuardianNoteRecoveryProgressStale(next) ? null : next);
  }, []);

  const refresh = useCallback(() => {
    if (!accountId) return;
    fetchGuardianNoteRecoveryProgress(accountId)
      .then(accept)
      .catch(error => console.warn('[wallet-prompts] failed to read note-recovery progress:', error));
  }, [accept, accountId]);

  useEffect(() => {
    if (!accountId) {
      setProgress(null);
      return;
    }
    cancelledRef.current = false;
    refresh();
    const unsubscribe = onStorageChanged(GUARDIAN_NOTE_RECOVERY_PROGRESS_STORAGE_KEY, value =>
      accept(normalizeGuardianNoteRecoveryProgress(value, accountId))
    );
    // Polled as well as subscribed, not instead: mobile and desktop get no
    // storage events at all (`onStorageChanged` is a no-op there), and on the
    // extension the listener is registered after an async import, so a write
    // landing in that window is missed. The poll is also what ages out a
    // record whose run died with its realm.
    const interval = setInterval(refresh, 2000);
    return () => {
      cancelledRef.current = true;
      unsubscribe();
      clearInterval(interval);
    };
  }, [accept, accountId, refresh]);

  return progress;
}

export function useWalletPromptStorage() {
  const [storage, setStorage] = useState<WalletPromptStorage>(EMPTY_WALLET_PROMPT_STORAGE);
  const [isLoaded, setIsLoaded] = useState(false);
  // Counts the changes this hook has issued. A record read or written before the latest
  // change predates it, so only an operation started after that change may replace state;
  // the newest write's own result already carries every earlier change.
  const changeCount = useRef(0);

  const refreshPrompts = useCallback(async () => {
    const startedAt = changeCount.current;
    const nextStorage = await inWalletPromptStorageTurn(fetchWalletPromptStorage);
    if (startedAt === changeCount.current) setStorage(nextStorage);
    setIsLoaded(true);
    return nextStorage;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const startedAt = changeCount.current;

    inWalletPromptStorageTurn(fetchWalletPromptStorage)
      .then(nextStorage => {
        if (!cancelled) {
          if (startedAt === changeCount.current) setStorage(nextStorage);
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

  // Shown at once, then persisted as the same change applied to the stored record, whose
  // result becomes the state if no later change was issued: a write elsewhere since this
  // hook last read is kept. A failed write reloads.
  const updateStorage = useCallback(
    (change: (current: WalletPromptStorage) => WalletPromptStorage) => {
      const issued = ++changeCount.current;
      setStorage(prev => change(normalizeWalletPromptStorage(prev)));
      updateWalletPromptStorage(change).then(
        next => {
          if (issued === changeCount.current) setStorage(next);
        },
        error => {
          console.warn('[wallet-prompts] failed to persist prompt status:', error);
          refreshPrompts().catch(reloadError =>
            console.warn('[wallet-prompts] failed to reload prompts after a failed write:', reloadError)
          );
        }
      );
    },
    [refreshPrompts]
  );

  const setPromptStatus = useCallback(
    (type: WalletWidePromptType, status: WalletPromptStatus, dismissedNoteIds?: readonly string[]) =>
      updateStorage(current => ({
        ...current,
        prompts: { ...current.prompts, [type]: status },
        pendingNotesDismissedIds:
          dismissedNoteIds === undefined
            ? current.pendingNotesDismissedIds
            : normalizePendingNotesDismissedIds(dismissedNoteIds)
      })),
    [updateStorage]
  );

  // The faucet prompt's status for one account address; see `faucetByAccount`.
  const setFaucetStatus = useCallback(
    (address: string, status: WalletPromptStatus) =>
      updateStorage(current => ({ ...current, faucetByAccount: { ...current.faucetByAccount, [address]: status } })),
    [updateStorage]
  );

  const dismissPrompt = useCallback(
    (type: WalletWidePromptType) => setPromptStatus(type, WalletPromptStatus.Dismissed),
    [setPromptStatus]
  );

  const completePrompt = useCallback(
    (type: WalletWidePromptType) => setPromptStatus(type, WalletPromptStatus.Completed),
    [setPromptStatus]
  );

  const isPromptPending = useCallback((type: WalletWidePromptType) => isWalletPromptPending(storage, type), [storage]);

  return {
    storage,
    isLoaded,
    refreshPrompts,
    setPromptStatus,
    setFaucetStatus,
    dismissPrompt,
    completePrompt,
    isPromptPending
  };
}
