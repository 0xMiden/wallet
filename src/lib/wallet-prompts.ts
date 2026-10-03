import { useCallback, useEffect, useRef, useState } from 'react';

import BigNumber from 'bignumber.js';

import {
  agglayerClaimedFields,
  isAgglayerDepositClaimed,
  isAgglayerDepositReady,
  isAgglayerExitUnfindable,
  searchAgglayerExitDeposit
} from 'lib/agglayer';
import { agglayerExitTxHashFromRowBytes } from 'lib/agglayer/b2agg/exit-hash';
import { MIDEN_CHAIN_ID_RENUMBERED_AT } from 'lib/agglayer/constant';
import {
  fetchGuardianNoteRecoveryProgress,
  GUARDIAN_NOTE_RECOVERY_PROGRESS_STORAGE_KEY,
  type GuardianNoteRecoveryProgress,
  isGuardianNoteRecoveryProgressStale,
  normalizeGuardianNoteRecoveryProgress
} from 'lib/guardian-note-recovery-progress';
import { compareAccountIds } from 'lib/miden/activity/utils';
import { IBridgedSendExtraInputs, ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import { fetchFromStorage, inStorageTurn, onStorageChanged, putToStorage } from 'lib/miden/front/storage';
import type { AssetMetadata } from 'lib/miden/metadata';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import * as Repo from 'lib/miden/repo';
import { withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { tokenQuote } from 'lib/miden/swap/tokens';
import {
  bridgedSendLandedValues,
  markAgglayerExitUnfiled,
  pinAgglayerDeposit,
  recordAgglayerExitTxHash,
  updateBridgeClaimStatus
} from 'lib/miden/transaction/complete';
import { isUnconfirmedFailure } from 'lib/miden/transaction/constants';
import { completeVerifiedLandedTransaction } from 'lib/miden/transaction/helper';
import type { ConsumableNote } from 'lib/miden/types';
import { ensureSdkWasmReady } from 'lib/miden-chain/constants';
import { FaucetOutcomeUnknownError, mintFromMidenFaucet } from 'lib/miden-chain/faucet-api';
import { getStorageProvider } from 'lib/platform/storage-adapter';
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
  faucetByAccount: {}
};

export type PendingNoteValue = Pick<ConsumableNote, 'id' | 'amount' | 'faucetId'> & {
  metadata: Pick<AssetMetadata, 'decimals' | 'symbol' | 'name' | 'scaleIsUnknown'>;
};

const VALID_STATUSES = new Set<string>(Object.values(WalletPromptStatus));
const VALID_TYPES = new Set<string>(Object.values(WalletPromptType).filter(type => type !== WalletPromptType.Faucet));

/**
 * The notes' USD total, or none when any of them has no quote or no known scale. It sits beside
 * the button that accepts exactly these transfers, so a sum over only some of them would misstate it.
 */
export function getPendingNotesUsdTotal(notes: readonly PendingNoteValue[], tokenPrices: TokenPrices): number | null {
  let total = 0;
  for (const note of notes) {
    // A registry faucet is priced by its id even when its note still carries the placeholder's
    // guessed decimals, so an unknown scale leaves no total, as a missing quote does.
    const quote = tokenQuote(tokenPrices, note.faucetId, note.metadata.symbol);
    if (!quote || !hasKnownScale(note.metadata)) return null;
    // `amount` is a base-units bigint string; BigNumber keeps full integer
    // precision where Number(amount) would silently round above 2^53.
    total += new BigNumber(note.amount).shiftedBy(-note.metadata.decimals).toNumber() * quote.price;
  }
  return total;
}

function isBridgePromptActive(tx: ITransaction): boolean {
  if (tx.status === ITransactionStatus.Failed) return false;
  // A restored row still DISPLAYS whatever the backup recorded, deliberately,
  // but it must not drive work: this prompt surfaces a Claim affordance that
  // signs an EVM transaction.
  if (tx.restoredFromBackup) return false;
  if (tx.type !== 'bridged-send') return false;
  if (tx.status !== ITransactionStatus.Completed) return true;

  const inputs: IBridgedSendExtraInputs = tx.extraInputs;
  if (inputs.provider === 'epoch') return inputs.epochStatus !== 'confirmed' && inputs.epochStatus !== 'failed';
  // A row whose exit no lookup can find is never polled, so nothing would ever clear its prompt (#1325).
  if (isAgglayerExitUnfindable(inputs)) return false;
  return inputs.claimStatus !== 'claimed' && inputs.claimStatus !== 'failed';
}

export async function fetchActiveBridgePrompts(accountId: string): Promise<ITransaction[]> {
  const rows = await Repo.transactions
    .filter(tx => tx.type === 'bridged-send' && compareAccountIds(tx.accountId, accountId))
    .toArray();
  return rows.filter(isBridgePromptActive).sort((left, right) => right.initiatedAt - left.initiatedAt);
}

// A background poll of a row whose landing is unknown has a terminal condition - it
// cannot rely on an answer ever arriving, the way a Completed row can. Windowed from
// the row's own failure stamp, not from initiatedAt alone: a stamp ahead of the clock
// pauses the poll until the clock reaches it, rather than reading as already elapsed.
// Longer than an Agglayer L2-to-L1 exit and any Epoch fill, so a bridge that landed is
// settled in the background, and one that never landed stops costing a fetch every
// tick; past it, the detail page's own on-demand tracker and fill poll still settle
// the row (#1250).
const FAILED_UNCONFIRMED_BRIDGE_POLL_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Poll one bridge row against its provider - a Completed row with something left to
 * settle, with no window, or a Failed row whose outcome `isUnconfirmedFailure` still
 * calls unknown AND is still within `FAILED_UNCONFIRMED_BRIDGE_POLL_WINDOW_MS` of its
 * own failure stamp: `completedAt` (written by `cancelTransaction` at the moment of
 * every failure) when present, `initiatedAt` otherwise - both stored in seconds. A
 * stamp ahead of the clock (a clock stepped back, or a stamp written while the clock
 * ran fast) pauses the poll until the clock reaches it, the same way the faucet
 * marker's `stampedAhead` already distrusts a future `requestedAt` in this file; the
 * total background polling still stays capped at 24 hours. Either way the row is
 * settled by evidence bound to it alone, never a general resweep of every Failed row
 * (#1250). `isBridgePromptActive` and the prompts built from it are unaffected: a
 * Failed row shows no Claim affordance until this promotes it.
 */
async function pollBridgedSend(tx: ITransaction): Promise<void> {
  if (tx.type !== 'bridged-send') return;
  const failedAtSeconds = tx.completedAt ?? tx.initiatedAt;
  const ageMs = Date.now() - failedAtSeconds * 1000;
  // An Unconfirmed row's landing is just as unknown, and its stamp is written the same way (#1081).
  const failedUnconfirmed =
    (tx.status === ITransactionStatus.Unconfirmed ||
      (tx.status === ITransactionStatus.Failed && isUnconfirmedFailure(tx))) &&
    ageMs >= 0 &&
    ageMs < FAILED_UNCONFIRMED_BRIDGE_POLL_WINDOW_MS;
  if (tx.status !== ITransactionStatus.Completed && !failedUnconfirmed) return;
  // Read defensively, the same way the promotion filter in `reconcileBridgedSends`
  // already does: a Failed row with no `extraInputs` at all must not crash the pass.
  const inputs = tx.extraInputs as IBridgedSendExtraInputs | undefined;
  if (!inputs) return;

  if (inputs.provider === 'agglayer') {
    // Bound to this row's own exit hash, the indexer's tx_hash for the B2AGG note it built: several rows can share
    // one destination address, and only this binding tells their deposits apart. A row without one, or one no lookup
    // can find, is never looked up, Failed or not (#1325).
    const exitTxHash = inputs.agglayerExitTxHash;
    if (
      inputs.claimStatus === 'claimed' ||
      !inputs.destinationAddress ||
      !exitTxHash ||
      isAgglayerExitUnfindable(inputs)
    ) {
      return;
    }
    const { deposit, complete } = await searchAgglayerExitDeposit(
      inputs.destinationAddress,
      exitTxHash,
      inputs.agglayerDepositCnt
    );
    if (!deposit) {
      // An exit filed before the renumbering is under network 78, which the indexer no longer serves; the bridge's
      // auto-claimer claimed every one, so its funds arrived. Only a miss over the whole history retires the row:
      // a later row's exit may not be filed yet.
      if (complete && inputs.agglayerDepositCnt === undefined && tx.initiatedAt < MIDEN_CHAIN_ID_RENUMBERED_AT) {
        await markAgglayerExitUnfiled(tx.id);
      }
      return;
    }
    // Every claim-status write carries the deposit's own tx_hash, so a Failed row is promoted by the first (#1250).
    // A claim by anyone settles the row: the bridge's auto-claimer claims every exit minutes after it is ready.
    if (isAgglayerDepositClaimed(deposit)) {
      await updateBridgeClaimStatus(tx.id, 'claimed', agglayerClaimedFields(deposit), deposit.tx_hash);
    } else if (isAgglayerDepositReady(deposit) && inputs.claimStatus === 'pending') {
      await updateBridgeClaimStatus(
        tx.id,
        'ready',
        { depositReady: true, agglayerDepositCnt: deposit.deposit_cnt },
        deposit.tx_hash
      );
    } else if (inputs.agglayerDepositCnt !== deposit.deposit_cnt) {
      // Whatever the claim status: a pin the address page contradicts (a reset indexer) would cost a failed GET and
      // a warning on every tick.
      await pinAgglayerDeposit(tx.id, deposit.deposit_cnt);
    }
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
 * Bind every Agglayer row built before its exit hash was stored at build time (#1325), from the bytes the
 * row kept, so it can find its own deposit. "Once" is a property of the data: a row answered either way,
 * with a hash or marked unavailable, is no longer a candidate.
 *
 * The decodes run in one labelled WASM hold, so a trap reaches `withWasmClientLock`, which retires the
 * client. Answers are kept as they are decoded: a trap keeps the rows decoded before it, marks only the row
 * it trapped on, and leaves the rows after it for the next tick. Each stored answer is also set on `rows`,
 * so this tick's poll already uses it. No sync-fuse key or ceiling: the hold makes only synchronous static
 * decodes and never calls the client, so it cannot park, and its one caller, the 8 s `BridgeIntentWatcher`
 * tick, skips a tick while a pass runs.
 */
async function backfillAgglayerExitTxHashes(rows: ITransaction[]): Promise<void> {
  const candidates = rows.filter(tx => {
    const inputs: IBridgedSendExtraInputs | undefined = tx.extraInputs;
    return (
      inputs?.provider === 'agglayer' &&
      inputs.agglayerExitTxHash === undefined &&
      !inputs.agglayerExitTxHashUnavailable
    );
  });
  if (candidates.length === 0) return;
  try {
    await ensureSdkWasmReady();
  } catch (error) {
    console.warn('[wallet-prompts] SDK not ready; the Agglayer exit back-fill waits for the next tick', error);
    return;
  }

  const answers: { tx: ITransaction; exitTxHash: string | undefined }[] = [];
  try {
    await withWasmClientLock(
      async () => {
        for (const tx of candidates) answers.push({ tx, exitTxHash: agglayerExitTxHashFromRowBytes(tx) });
      },
      { label: 'agglayer-exit-backfill' }
    );
  } catch (error) {
    console.warn('[wallet-prompts] Agglayer exit back-fill stopped', error);
    // On a trap, the lock has retired the client. The row the trap hit is the first one with no answer; marking
    // it keeps the next tick from trapping on it again.
    const trapped = candidates[answers.length];
    if (error instanceof WebAssembly.RuntimeError && trapped !== undefined) {
      answers.push({ tx: trapped, exitTxHash: undefined });
    }
  }

  for (const { tx, exitTxHash } of answers) {
    try {
      await recordAgglayerExitTxHash(tx.id, exitTxHash);
      tx.extraInputs =
        exitTxHash === undefined
          ? { ...tx.extraInputs, agglayerExitTxHashUnavailable: true }
          : { ...tx.extraInputs, agglayerExitTxHash: exitTxHash };
    } catch (error) {
      // Still a candidate, so the next tick writes it again.
      console.warn('[wallet-prompts] Agglayer exit back-fill write failed', tx.id, error);
    }
  }
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
  const active = rows.filter(tx => !tx.restoredFromBackup);
  // Before the poll, so a row bound on this tick is looked up on this tick.
  await backfillAgglayerExitTxHashes(active);

  // A Failed row whose stored Epoch evidence already proves it landed settles
  // without waiting for another poll. Only stored Epoch evidence qualifies: it
  // is keyed by the row's own intent nonce, where a stored Agglayer claim
  // status carries no bound deposit hash and is never enough on its own
  // (#1250).
  await Promise.all(
    active
      .filter(tx => {
        if (tx.status !== ITransactionStatus.Failed) return false;
        const inputs = tx.extraInputs as IBridgedSendExtraInputs | undefined;
        if (!inputs) return false;
        return inputs.epochStatus === 'confirmed' && inputs.claimStatus !== 'failed';
      })
      .map(tx =>
        // One row's failing write must not reject the pass for the others.
        completeVerifiedLandedTransaction(tx.id, bridgedSendLandedValues()).catch(error =>
          console.warn('[wallet-prompts] bridged-send landing failed', tx.id, error)
        )
      )
  );

  await Promise.all(
    active.map(tx =>
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
// The turn is a storage turn (`inStorageTurn`): the Web Lock the extension's popup, side panel,
// tabs and service worker share, so a surface cannot put back a field another surface just
// changed, or without Web Locks this realm's own chain.
// There is no timeout on a turn: a write already sent to storage cannot be called back,
// so starting the next one early would let the slow one land over it.
function inWalletPromptStorageTurn(operation: () => Promise<WalletPromptStorage>): Promise<WalletPromptStorage> {
  return inStorageTurn(`turn:${WALLET_PROMPTS_STORAGE_KEY}`, operation);
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
 * Surface the "Everyday key needs rotation" prompt. Called (via a lazy import)
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
  // The arrival window ended with the mint's outcome unknown. The card asks from the derived
  // state (sent and past its window); what the flag adds is surviving a clock stepped back,
  // where a stamp in the future hides that state: a flagged record is kept and never read as
  // live. A sent record the step reaches before it is flagged reads back flagged.
  unresolved?: true;
};

const faucetFundingMarkerKey = (address: string) => `faucet_funding_v2:${address}`;

/** The one reading of a stored funding marker, whatever holds it; null when the value is not one. */
export function parseFaucetFundingMarker(raw: unknown): FaucetFundingMarker | null {
  if (!raw || typeof raw !== 'object') return null;
  const requestedAt = Reflect.get(raw, 'requestedAt');
  const baselineNoteIds = Reflect.get(raw, 'baselineNoteIds');
  if (typeof requestedAt !== 'number' || !Number.isFinite(requestedAt)) return null;
  const storedSubmitted = Reflect.get(raw, 'submitted') !== undefined;
  const storedUnresolved = Reflect.get(raw, 'unresolved') !== undefined;
  // A persisted wall-clock stamp is untrusted input: a forward clock step (NTP,
  // a manual change) leaves a stamp in the future, which reads as "always
  // fresh" and would wedge the wait past its own timeout. An unsent marker is dropped.
  // A sent one reads as unresolved, flagged or not: that is never live, so its stamp
  // wedges nothing, and dropping it would let a second request go out unasked.
  const stampedAhead = requestedAt > Date.now();
  if (stampedAhead && !storedSubmitted && !storedUnresolved) return null;
  if (!Array.isArray(baselineNoteIds)) return null;
  const marker: FaucetFundingMarker = {
    requestedAt,
    baselineNoteIds: baselineNoteIds.filter((id): id is string => typeof id === 'string')
  };
  // Any stored value reads as submitted: erring the other way would clear a marker
  // for a mint that could still land.
  if (storedSubmitted) marker.submitted = true;
  // Any stored value reads as unresolved: erring the other way would resubmit silently. Only
  // a sent request is left unresolved, so the flag also reads as sent.
  if (storedUnresolved || stampedAhead) {
    marker.submitted = true;
    marker.unresolved = true;
  }
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

export async function fetchFaucetFundingMarker(address: string): Promise<FaucetFundingMarker | null> {
  return parseFaucetFundingMarker(await fetchFromStorage(faucetFundingMarkerKey(address)));
}

/**
 * Runs `operation` holding the funding-marker lock for `address`, a storage turn (`inStorageTurn`).
 * Every read of the marker that decides a write to it runs under this lock: navigator.locks is
 * shared by the extension's popup, side panel, tabs and service worker, so two surfaces can no
 * longer both find no live marker and both send. Without Web Locks it still returns a promise, so a
 * caller's `.catch` sees any failure.
 */
export function withFaucetFundingMarkerLock(address: string, operation: () => Promise<void>): Promise<void> {
  return inStorageTurn(`faucet-funding-marker:${address}`, operation);
}

export async function setFaucetFundingMarker(address: string, marker: FaucetFundingMarker): Promise<void> {
  await putToStorage(faucetFundingMarkerKey(address), marker);
}

// A cleared marker leaves no key behind, rather than a stored null.
export async function clearFaucetFundingMarker(address: string): Promise<void> {
  await getStorageProvider().remove([faucetFundingMarkerKey(address)]);
}

// 100 MIDEN in base units (6 decimals).
const MIDEN_FAUCET_AMOUNT = 100_000_000n;
// Bail out of a hung faucet request. The timeout also aborts the underlying
// work: the signal is linked into each fetch, checked per PoW iteration, and
// cuts a 429 back-off short.
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
 * certainly passed, and a flagged one waits out the arrival window from when it went out,
 * unless a surface already flagged it unresolved when that window ended.
 */
export function isFaucetFundingMarkerLive(
  marker: FaucetFundingMarker,
  { runningHere, settledAt }: { runningHere: boolean; settledAt: number | null }
): boolean {
  if (runningHere) return true;
  if (marker.unresolved) return false;
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

/**
 * A request refused because the account's stored request is unresolved and the caller did not
 * name it as the one the user confirmed replacing; `record` is that request. Nothing was sent.
 */
export class FaucetRequestUnresolvedError extends Error {
  readonly record: Pick<FaucetFundingMarker, 'requestedAt' | 'baselineNoteIds'>;

  constructor({ requestedAt, baselineNoteIds }: Pick<FaucetFundingMarker, 'requestedAt' | 'baselineNoteIds'>) {
    super('An earlier faucet request for this account is unresolved');
    this.name = 'FaucetRequestUnresolvedError';
    this.record = { requestedAt, baselineNoteIds };
  }
}

async function runFaucetRequest(address: string, marker?: FaucetFundingMarker, replaces?: number): Promise<void> {
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
        // The user is asked before a request replaces an unresolved one, but a surface that read
        // storage before another surface flagged it never asked: only a confirmed replacement passes.
        // Every live record of another request was refused above, so another one read as sent (a
        // flagged one always is) is past its window: unresolved flagged or not, as the mount read
        // treats it, since the flag is best effort and a surface whose read failed never saw it.
        if (
          stored !== null &&
          stored.requestedAt !== marker.requestedAt &&
          stored.submitted &&
          replaces !== stored.requestedAt
        ) {
          throw new FaucetRequestUnresolvedError(stored);
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
 * never went out. A stored unresolved request is replaced only when `replaces` names
 * its `requestedAt`, the request the user confirmed replacing; any other request is
 * refused with `FaucetRequestUnresolvedError`.
 */
export function faucet(
  address: string,
  marker?: FaucetFundingMarker,
  { replaces }: { replaces?: number } = {}
): Promise<void> {
  const existing = inFlightFaucetRequests.get(address);
  if (existing) return existing.request;
  const recordSettled = () => {
    if (marker) settledFaucetRequests.set(address, { requestedAt: marker.requestedAt, settledAt: Date.now() });
  };
  // Storage reads settle asynchronously, so a reader of the marker always finds
  // this request registered by the `set` below. A joiner's marker is ignored: the
  // request it joins already persists its own.
  const request: Promise<void> = runFaucetRequest(address, marker, replaces)
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
 * The live progress record of the post-seed-recovery pending-note scan, or a
 * terminal 'history-partial'/'history-failed' record until its card is
 * dismissed or the next run replaces it; null otherwise. Extension surfaces
 * get push updates via storage change events (the SW writes through the same
 * storage area); mobile/desktop have no storage events, so a light poll keeps
 * the card advancing there too.
 *
 * `pending` is the viewed account's `guardianNoteRecoveryPending` flag. Only a
 * pending account can have a run to narrate, so only then is the record
 * subscribed to and polled. A terminal history failure clears the flag and
 * keeps its record, so without the flag the record is read once per account
 * and returned only when its step is 'history-failed'. Every other wallet,
 * nearly all of them nearly always, does one read. Pass null for no account.
 *
 * Records are stored per account, so a run for a different recovered account
 * cannot narrate itself on this account's home view.
 */
export function useGuardianNoteRecoveryProgress(
  accountId: string | null,
  pending = true
): GuardianNoteRecoveryProgress | null {
  const [progress, setProgress] = useState<GuardianNoteRecoveryProgress | null>(null);
  const cancelledRef = useRef(false);

  // The age rule drops only a live-step record whose run died with its realm:
  // that card is non-dismissible, so without it the card would sit on screen
  // forever. A terminal record stays until its card is dismissed or the next
  // run replaces it.
  const accept = useCallback(
    (next: GuardianNoteRecoveryProgress | null) => {
      if (cancelledRef.current) return;
      if (!pending) setProgress(next?.step === 'history-failed' ? next : null);
      else setProgress(next && isGuardianNoteRecoveryProgressStale(next) ? null : next);
    },
    [pending]
  );

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
    if (!pending) {
      return () => {
        cancelledRef.current = true;
      };
    }
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
  }, [accept, accountId, pending, refresh]);

  // State outlives an account switch until the new account's read lands, so another account's card never shows.
  return progress?.accountId === accountId ? progress : null;
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
    (type: WalletWidePromptType, status: WalletPromptStatus) =>
      updateStorage(current => ({ ...current, prompts: { ...current.prompts, [type]: status } })),
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
