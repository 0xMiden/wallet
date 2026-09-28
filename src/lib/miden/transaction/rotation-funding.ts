import { isWorthClaiming, totalClaimableAmount } from 'lib/miden/fees/spendable';
import * as Repo from 'lib/miden/repo';

import { initiateRotationFundingClaim, type RotationFundingClaimOptions } from './initiate';
import { isLiveTransaction, ITransaction } from '../db/types';
import { ConsumableNote } from '../types';

/**
 * The Web Lock the everyday-key rotation and its funding claim both take (#805), so
 * neither is queued while a row of the other kind is live, from any wallet surface.
 */
export const hotKeyRotationLockName = (accountPublicKey: string): string => `hot-key-rotation:${accountPublicKey}`;

type GateRowShape = Pick<ITransaction, 'type' | 'accountId' | 'status' | 'rotationFunding'>;

export const isRotationRow = (row: GateRowShape, accountPublicKey: string): boolean =>
  row.type === 'replace-hot-key' && row.accountId === accountPublicKey;

export const isRotationFundingRow = (row: GateRowShape, accountPublicKey: string): boolean =>
  row.type === 'consume' && row.rotationFunding === true && row.accountId === accountPublicKey;

export const isLiveRotationRow = (row: GateRowShape, accountPublicKey: string): boolean =>
  isRotationRow(row, accountPublicKey) && isLiveTransaction(row);

export const isLiveRotationFundingRow = (row: GateRowShape, accountPublicKey: string): boolean =>
  isRotationFundingRow(row, accountPublicKey) && isLiveTransaction(row);

/** The part of a claimable-notes read the selection needs: the list, and whether it is only the cache. */
export interface ClaimableNotesSnapshot<T> {
  data?: readonly T[];
  isFallback: boolean;
}

type FundingNoteShape = Pick<ConsumableNote, 'faucetId' | 'amount' | 'swapOrder' | 'isBeingClaimed' | 'fromCache'>;

export interface RotationFundingSelection<T> {
  /** Every native, non-swap note a live read lists, claimed or not: what the gate watches vanish. */
  native: T[];
  /** What one claim takes now: the unclaimed native notes, when together they are worth one fee. */
  batch: T[];
  /** Unclaimed native notes are listed, but together they are worth less than a claim costs. */
  tooSmall: boolean;
}

/**
 * The notes the rotation gate may claim (#805). Only a live list counts: the cached list
 * is display-only, and on the extension a snapshot a previous session left behind. The
 * batch is measured by `isWorthClaiming` on its total, the rule every unattended claim
 * uses, and goes out whole, since one claim pays one fee.
 */
export function selectRotationFundingNotes<T extends FundingNoteShape>(
  list: ClaimableNotesSnapshot<T>,
  feeFaucetId: string | null,
  baseFee: number | null
): RotationFundingSelection<T> {
  if (list.isFallback || !list.data || feeFaucetId === null) return { native: [], batch: [], tooSmall: false };
  const native = list.data.filter(note => note.faucetId === feeFaucetId && !note.swapOrder && !note.fromCache);
  const unclaimed = native.filter(note => !note.isBeingClaimed);
  if (unclaimed.length === 0) return { native, batch: [], tooSmall: false };
  const worthIt = isWorthClaiming(totalClaimableAmount(unclaimed.map(note => note.amount)), baseFee);
  return { native, batch: worthIt ? unclaimed : [], tooSmall: !worthIt };
}

/**
 * Queue the gate's funding claim unless the rotation is live, under the rotation's own
 * lock. Resolves to the id `initiateRotationFundingClaim` returns, or `null` when a
 * rotation row blocked it.
 */
export async function enqueueRotationFundingClaim(
  accountPublicKey: string,
  notes: ConsumableNote[],
  opts: RotationFundingClaimOptions
): Promise<string | null> {
  let txId: string | null = null;
  await navigator.locks.request(hotKeyRotationLockName(accountPublicKey), async () => {
    const rotation = await Repo.transactions.filter(row => isLiveRotationRow(row, accountPublicKey)).first();
    if (rotation) return;
    txId = await initiateRotationFundingClaim(accountPublicKey, notes, opts);
  });
  return txId;
}
