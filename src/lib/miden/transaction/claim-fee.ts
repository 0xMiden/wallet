import { getMessage } from 'lib/i18n/core';
import { ClaimFeeNote } from 'lib/miden/fees/spendable';
import { getNativeAssetId, getVerificationBaseFee } from 'lib/miden-chain/native-asset';

import { getUncompletedTransactions } from './get';
import { readVaultHoldings } from './vault-read';
import { ITransaction } from '../db/types';
import { ConsumableNote } from '../types';

export class ClaimFeeRefusedError extends Error {
  constructor() {
    super(getMessage('insufficientFeeAsset'));
    this.name = 'ClaimFeeRefusedError';
  }
}

/**
 * An unattended claim was not queued: the notes that remain after dedup and backoff are worth less than the claim
 * floor (#2192). It extends {@link ClaimFeeRefusedError} because the auto-consumers handle the two refusals the same
 * way: the notes stay pending, and there is no per-note fallback and no processing request.
 */
export class ClaimBelowFloorError extends ClaimFeeRefusedError {
  constructor() {
    super();
    this.message = 'Claim not queued: the remaining notes are worth less than the claim floor';
    this.name = 'ClaimBelowFloorError';
  }
}

export interface ClaimFeeContext {
  vaultFeeAsset: bigint | null;
  nativeAssetId: string | null;
  verificationBaseFee: number | null;
}

/** Read before entering Dexie; an unavailable fact cannot establish a fee shortfall. */
export async function readClaimFeeContext(accountId: string): Promise<ClaimFeeContext> {
  let nativeAssetId: string | null = null;
  let verificationBaseFee: number | null = null;
  try {
    const nativeId = await getNativeAssetId();
    nativeAssetId = nativeId;
    verificationBaseFee = await getVerificationBaseFee();
    if (
      !nativeId ||
      verificationBaseFee === null ||
      !Number.isFinite(verificationBaseFee) ||
      verificationBaseFee <= 0
    ) {
      return { vaultFeeAsset: null, nativeAssetId, verificationBaseFee };
    }
    const held = await readVaultHoldings(accountId, 'claim-fee');
    return { vaultFeeAsset: held === null ? null : (held.get(nativeId) ?? 0n), nativeAssetId, verificationBaseFee };
  } catch {
    // A trap must reach the lock's retirement path before it becomes an unknown holding.
    return { vaultFeeAsset: null, nativeAssetId, verificationBaseFee };
  }
}

export function claimFeeNotes(
  notes: readonly ConsumableNote[],
  feeNotesById?: ReadonlyMap<string, readonly ClaimFeeNote[]>
): ClaimFeeNote[] {
  return notes.flatMap(note => {
    const feeNotes = feeNotesById?.get(note.id);
    // A supplied list describes all fee assets; it need not replace the row's display fields.
    if (feeNotes !== undefined && note.id.trim()) {
      return feeNotes.map(fact => ({
        ...fact,
        assetsUnknown: fact.assetsUnknown || !note.id.trim() || !fact.faucetId.trim() || !fact.amount.trim()
      }));
    }
    return [
      {
        faucetId: note.faucetId,
        amount: note.amount,
        carriesMoreAssets: note.carriesMoreAssets,
        assetsUnknown:
          feeNotes !== undefined ||
          typeof note.carriesMoreAssets !== 'boolean' ||
          !note.id.trim() ||
          !note.faucetId.trim() ||
          !note.amount.trim()
      }
    ];
  });
}

export function persistedClaimFeeNotes(
  row: Pick<ITransaction, 'noteId' | 'noteIds' | 'consumedNotes'>
): ClaimFeeNote[] {
  const records = new Map(row.consumedNotes?.map(note => [note.id, note]));
  const ids = new Set([...(row.noteIds ?? []), ...(row.noteId !== undefined ? [row.noteId] : [])]);
  // Missing records are possible funding, including a legacy row with no note identifiers.
  if (ids.size === 0) return [{ faucetId: '', amount: '', assetsUnknown: true }];
  return Array.from(ids).flatMap<ClaimFeeNote>(id => {
    const note = records.get(id);
    if (note?.feeAssets !== undefined && id.trim()) {
      return note.feeAssets.map(asset => ({
        faucetId: asset.faucetId,
        amount: asset.amount.toString(),
        carriesMoreAssets: false,
        assetsUnknown: !asset.faucetId.trim()
      }));
    }
    return [
      {
        faucetId: note?.faucetId ?? '',
        amount: note?.amount?.toString() ?? '',
        carriesMoreAssets: note?.carriesMoreAssets,
        assetsUnknown:
          !id.trim() ||
          !note ||
          typeof note.carriesMoreAssets !== 'boolean' ||
          !note.faucetId.trim() ||
          note.amount === undefined
      }
    ];
  });
}

/** Uses the processing queue's account and status semantics, including restored consumes. */
export async function getClaimFeeAhead(accountId: string, excludeTxId?: string): Promise<ClaimFeeNote[]> {
  return (await getUncompletedTransactions(accountId))
    .filter(row => row.type === 'consume' && row.id !== excludeTxId)
    .flatMap(persistedClaimFeeNotes);
}
