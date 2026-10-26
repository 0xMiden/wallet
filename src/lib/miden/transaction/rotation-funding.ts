import { isWorthClaiming, totalClaimableAmount } from 'lib/miden/fees/spendable';
import * as Repo from 'lib/miden/repo';

import { isVaultShortfallRow } from './constants';
import { isLiveTransaction, ITransaction, ITransactionStatus } from '../db/types';
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

type QueuedRowShape = Pick<ITransaction, 'initiatedAt' | 'queuedSeq'>;

const queuedLater = (a: QueuedRowShape, b: QueuedRowShape): boolean =>
  a.initiatedAt > b.initiatedAt || (a.initiatedAt === b.initiatedAt && (a.queuedSeq ?? 0) > (b.queuedSeq ?? 0));

/** The most recently queued of `rows`. */
export const newestRow = <T extends QueuedRowShape>(rows: readonly T[]): T | undefined =>
  rows.reduce<T | undefined>(
    (newest, row) => (newest === undefined || queuedLater(row, newest) ? row : newest),
    undefined
  );

/**
 * The account's newest everyday-key rotation when it failed for want of its fee and no
 * funding claim completed after that failure (#805), else `undefined`. The gate adopts it
 * on mount, showing the funding panel again instead of queueing a rotation that must
 * fail, minting a hot key it never uses. After a completed claim the gate queues the
 * rotation next, so there is then nothing to adopt.
 */
export async function findAdoptableShortfallRow(accountPublicKey: string): Promise<ITransaction | undefined> {
  const rows = await Repo.transactions
    .filter(row => isRotationRow(row, accountPublicKey) || isRotationFundingRow(row, accountPublicKey))
    .toArray();
  const rotation = newestRow(rows.filter(row => row.type === 'replace-hot-key'));
  if (rotation === undefined || !isVaultShortfallRow(rotation)) return undefined;
  const failedAt = rotation.completedAt ?? rotation.initiatedAt;
  const claimedSince = rows.some(
    row => row.type === 'consume' && row.status === ITransactionStatus.Completed && (row.completedAt ?? 0) > failedAt
  );
  return claimedSince ? undefined : rotation;
}

/** The part of a claimable-notes read the selection needs: the list, and whether it is only the cache. */
export interface ClaimableNotesSnapshot<T> {
  data?: readonly T[];
  isFallback: boolean;
}

type FundingNoteShape = Pick<
  ConsumableNote,
  'faucetId' | 'amount' | 'swapOrder' | 'isBeingClaimed' | 'fromCache' | 'standardPayment'
>;

export interface RotationFundingSelection<T> {
  /** Every native, non-swap, standard payment note a live read lists, claimed or not: what the gate watches vanish. */
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
 * uses, and goes out in claims of at most MAX_NOTES_PER_UNATTENDED_CLAIM notes (`chunkAutoConsumeBatch`, #1644).
 *
 * Only standard P2ID or P2IDE payments, a missing flag read as not: generation refuses a
 * whole claim over one other note, and a note worth less than its own fee is never split
 * out of a batch, so one such note would lock the gate.
 */
export function selectRotationFundingNotes<T extends FundingNoteShape>(
  list: ClaimableNotesSnapshot<T>,
  feeFaucetId: string | null,
  baseFee: number | null
): RotationFundingSelection<T> {
  if (list.isFallback || !list.data || feeFaucetId === null) return { native: [], batch: [], tooSmall: false };
  const native = list.data.filter(
    note => note.faucetId === feeFaucetId && !note.swapOrder && !note.fromCache && note.standardPayment === true
  );
  const unclaimed = native.filter(note => !note.isBeingClaimed);
  if (unclaimed.length === 0) return { native, batch: [], tooSmall: false };
  const worthIt = isWorthClaiming(totalClaimableAmount(unclaimed.map(note => note.amount)), baseFee);
  return { native, batch: worthIt ? unclaimed : [], tooSmall: !worthIt };
}
