import {
  netOutflowByFaucet,
  summaryBytesToView,
  toHoldingsView,
  type AssetAmount,
  type TxAssetView,
  type ViewNote
} from 'app/confirm/decode';
import { getMessage } from 'lib/i18n/core';
import {
  getVerificationBaseFeeSync,
  isVerificationBaseFeeKnownAbsent,
  refreshVerificationBaseFee
} from 'lib/miden-chain/native-asset';

import { ProposalEffectRefusedError, ProposalFeeUnknownError } from './constants';
import type { IConsumeGcPurchaseExtraInputs, IExecuteApproval, ITransaction, ITransactionType } from '../db/types';
import { canonicalWalletAccountId } from '../sdk/helpers';
import { withWasmClientLock } from '../sdk/miden-client';
import { isKilledPipeline } from '../sdk/sdk-error-code';

/** What a row may move out of the account beyond the network fee: amounts by faucet, and NFTs by `nftKey`. */
interface Allowance {
  outflow: AssetAmount[];
  nfts: readonly string[];
  /**
   * Present: what leaves is measured from the account's holdings (`toHoldingsView`), crediting only these consumed
   * notes. Absent: the view's net change.
   */
  introducedNoteIds?: readonly string[];
  /** Present: the notes it may create; `'assetless'`: only notes that carry nothing. Absent: unbound. */
  outputNoteIds?: readonly string[] | 'assetless';
}

const approvedTransfer = ({ faucetId, amount }: ITransaction): Allowance => {
  if (typeof faucetId !== 'string' || faucetId.length === 0 || typeof amount !== 'bigint' || amount < 0n) {
    throw new Error('the transaction has no valid approved asset and amount');
  }
  return { outflow: [{ faucetId, amount }], nfts: [] };
};

/** The allowance of each checked type. A type with no entry is not checked. */
const ALLOWED_OUTFLOW: Partial<Record<ITransactionType, (transaction: ITransaction) => Allowance>> = {
  send: approvedTransfer,
  swap: approvedTransfer,
  'earn-deposit': approvedTransfer,
  // A claim only takes in. The one consume that pays is an Arcade GC purchase, which pays its quoted fill.
  consume: transaction => {
    const purchase: IConsumeGcPurchaseExtraInputs['gcPurchase'] | undefined = transaction.extraInputs?.gcPurchase;
    return {
      outflow: purchase ? [{ faucetId: purchase.payFaucetId, amount: BigInt(purchase.fillAmount) }] : [],
      nfts: []
    };
  },
  // What the approval-time dry run showed leaving; a row queued before that was recorded falls back to its policy
  // totals. A dry run that failed recorded neither, and a row queued before NFTs were recorded has none, so such a row
  // may move nothing. A row that recorded no notes credits no consumed note and may create only notes carrying nothing.
  execute: transaction => ({
    outflow: (transaction.approvedOutflow ?? transaction.spentAssetTotals ?? []).map(asset => ({
      faucetId: asset.faucetId,
      amount: BigInt(asset.amount)
    })),
    nfts: transaction.approvedNftOutflow ?? [],
    introducedNoteIds: transaction.approvedEffects?.introducedNoteIds ?? [],
    outputNoteIds: transaction.approvedEffects?.approvedOutputNoteIds ?? 'assetless'
  })
};

export const isEffectChecked = (type: ITransactionType): boolean => ALLOWED_OUTFLOW[type] !== undefined;

const carriesNothing = (note: ViewNote): boolean =>
  note.opaque !== true && note.amounts.length === 0 && note.nfts.length === 0;

/**
 * Why `view` moves more than `transaction` was approved to move, or undefined when it does not (or its type is not
 * checked).
 *
 * A claim is measured on the summary's NET vault change with the fee taken out (`summaryToView`): it only takes in.
 * A custom transaction is measured from the account's holdings: a consumed note counts as brought in only when its
 * approval recorded it, so a note the account already held is value it spends. Each note it creates must be one its
 * approval recorded, by id, which commits to the note's assets and recipient.
 */
export function proposalEffectRefusal(transaction: ITransaction, view: TxAssetView): string | undefined {
  const allowedOutflow = ALLOWED_OUTFLOW[transaction.type];
  if (allowedOutflow === undefined) return undefined;
  const allowance = allowedOutflow(transaction);
  let measured = view;
  if (allowance.introducedNoteIds !== undefined) {
    try {
      measured = toHoldingsView(view, allowance.introducedNoteIds);
    } catch (error) {
      return `the notes it consumes could not be measured (${error instanceof Error ? error.message : String(error)})`;
    }
  }
  const allowed = new Map<string, bigint>();
  for (const asset of allowance.outflow) {
    const faucetId = canonicalWalletAccountId(asset.faucetId);
    allowed.set(faucetId, (allowed.get(faucetId) ?? 0n) + asset.amount);
  }
  const reasons = netOutflowByFaucet(measured)
    .filter(asset => asset.amount > (allowed.get(asset.faucetId) ?? 0n))
    .map(asset => `${asset.amount} of ${asset.faucetId} leaves (approved ${allowed.get(asset.faucetId) ?? 0n})`);
  const allowedNfts = new Set(allowance.nfts);
  for (const nft of measured.outgoingNfts) {
    if (nft.key === undefined || !allowedNfts.has(nft.key)) reasons.push(`an unapproved NFT of ${nft.faucetId} leaves`);
  }
  // A vault change the summary cannot list may be an asset leaving, so it is never taken as nothing moving.
  if (view.unlistedAssets > 0) reasons.push(`${view.unlistedAssets} vault change(s) the summary does not list`);
  const bound = allowance.outputNoteIds;
  if (bound !== undefined) {
    const approvedIds = bound === 'assetless' ? undefined : new Set(bound.map(id => id.toLowerCase()));
    if (view.createdNotes === undefined) reasons.push('the notes it creates could not be read');
    for (const note of view.createdNotes ?? []) {
      const approved = approvedIds === undefined ? carriesNothing(note) : approvedIds.has(note.id.toLowerCase());
      if (!approved) reasons.push(`creates a note that was not approved (${note.id})`);
    }
  }
  return reasons.length > 0 ? reasons.join('; ') : undefined;
}

/**
 * What an approval of `view` lets signing move, measured as `proposalEffectRefusal` measures a custom transaction:
 * from the account's holdings, crediting only `introducedNoteIds`, the consumed notes the request brought in. Throws
 * for a view that does not list its notes, or one already measured from holdings, which would count its held notes
 * twice.
 */
export function executeApprovalOf(view: TxAssetView, introducedNoteIds: readonly string[]): IExecuteApproval {
  if (view.heldNotesSpent !== undefined) throw new Error('the view is already measured from holdings');
  const created = view.createdNotes;
  if (created === undefined) throw new Error('the view does not list the notes it creates');
  const holdings = toHoldingsView(view, introducedNoteIds);
  return {
    approvedOutflow: netOutflowByFaucet(holdings),
    approvedNftOutflow: holdings.outgoingNfts.flatMap(nft => (nft.key === undefined ? [] : [nft.key])),
    introducedNoteIds: [...new Set(introducedNoteIds.map(id => id.toLowerCase()))],
    approvedOutputNoteIds: created.map(note => note.id)
  };
}

/** The refusal the effect check throws for `transaction`, with the localized sentence the row shows. */
export const effectRefusal = (transaction: ITransaction, detail: string, cause?: unknown): ProposalEffectRefusedError =>
  new ProposalEffectRefusedError(
    transaction.type,
    detail,
    getMessage('proposalEffectRefused'),
    cause === undefined ? undefined : { cause }
  );

/** Decode `transaction`'s view and refuse it when it moves more than the row was approved to move. */
async function assertDecodedViewApproved(
  transaction: ITransaction,
  decode: () => TxAssetView | Promise<TxAssetView>
): Promise<void> {
  let view: TxAssetView;
  try {
    view = await decode();
  } catch (error) {
    // A trap stays that same error. Wrapping it would hide the object from the retire that owns it.
    if (error instanceof WebAssembly.RuntimeError) throw error;
    if (isKilledPipeline(error) || error instanceof ProposalEffectRefusedError) throw error;
    throw effectRefusal(transaction, 'the transaction summary could not be read', error);
  }
  let detail: string | undefined;
  try {
    detail = proposalEffectRefusal(transaction, view);
  } catch (error) {
    throw effectRefusal(transaction, 'its approved amounts could not be read', error);
  }
  if (detail !== undefined) throw effectRefusal(transaction, detail);
}

/**
 * Refuse a checked-type transaction whose decoded view moves more than its row was approved to move. `decode` is a
 * thunk because the chain-fee lookup must run first: the decoder reads the fee that lookup fills. A decode that throws
 * a refusal passes through, a kill of the decoding hold passes through, a trap passes through as that same error,
 * and any other failure becomes a refusal.
 */
export async function assertViewEffectApproved(
  transaction: ITransaction,
  decode: () => TxAssetView | Promise<TxAssetView>
): Promise<void> {
  if (!isEffectChecked(transaction.type)) return;
  // The fee note is told apart only once this realm knows the chain's fee; an untold fee reads as an outflow and
  // refuses, so it is read from the chain first rather than left to whatever this realm cached. A null while the read
  // failed or the probe is cooling down is not an answer, and the summary stays unread. A number, 0 included, and a
  // null the probe found absent, both continue; the decoder reads the fee the await just filled.
  const chainFee = await refreshVerificationBaseFee();
  if (chainFee === null && !isVerificationBaseFeeKnownAbsent())
    throw new ProposalFeeUnknownError(getMessage('chainFeeUnknown'));
  await assertDecodedViewApproved(transaction, decode);
}

/**
 * The signer's effect check. The write decided the chain fee before it ran, and this reads that cache. A null while
 * the probe has not found the fee absent throws, and the summary stays unread. A number, 0 included, and a null the
 * probe found absent, both continue into the same decode as `assertViewEffectApproved`.
 */
export async function assertCachedViewEffectApproved(
  transaction: ITransaction,
  decode: () => TxAssetView | Promise<TxAssetView>
): Promise<void> {
  if (!isEffectChecked(transaction.type)) return;
  const chainFee = getVerificationBaseFeeSync();
  if (chainFee === null && !isVerificationBaseFeeKnownAbsent())
    throw new ProposalFeeUnknownError(getMessage('chainFeeUnknown'));
  await assertDecodedViewApproved(transaction, decode);
}

/**
 * Refuse a proposal of a checked type whose summary moves more than its row was approved to move (#2147). Runs before
 * the hot key signs: it signs this summary's commitment, so the summary is what lands. A summary that is missing or
 * does not decode is refused too; a kill of the decoding hold passes through unchanged.
 */
export async function assertProposalEffectApproved(
  transaction: ITransaction,
  txSummary: string | undefined
): Promise<void> {
  if (!isEffectChecked(transaction.type)) return;
  if (typeof txSummary !== 'string' || txSummary.length === 0) {
    throw effectRefusal(transaction, 'the proposal carries no transaction summary');
  }
  await assertViewEffectApproved(transaction, async () => {
    try {
      // A trap rejects the hold's callback, so the lock retires the client before the refusal wraps it.
      return await withWasmClientLock(async () => summaryBytesToView(txSummary), { label: 'proposal effect check' });
    } catch (error) {
      if (isKilledPipeline(error)) throw error;
      throw effectRefusal(transaction, 'the proposal summary could not be read', error);
    }
  });
}
