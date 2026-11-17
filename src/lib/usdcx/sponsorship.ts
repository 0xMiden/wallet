import type { AssetAmount, ViewNote } from 'app/confirm/decode';
import type { ITransaction, IUsdcxNetworkFeeBudget } from 'lib/miden/db/types';
import { canonicalFeeSponsorshipNoteId } from 'lib/miden/sdk/fee-sponsorship';
import { canonicalWalletAccountId } from 'lib/miden/sdk/helpers';
import { getNativeAssetIdSync, getSdkSyncedNativeAssetIdSync } from 'lib/miden-chain/native-asset';

import { currentUsdcxFeeScope } from './fee-scope';

export type SponsorshipNote = Pick<ViewNote, 'id' | 'amounts' | 'opaque'> & { nfts: readonly unknown[] };

export interface UsdcxSponsorshipApproval {
  accountId: string;
  faucetId: string;
  noteId: string;
  budget: IUsdcxNetworkFeeBudget;
}

/** Missing old-row consent is not replaced by a new estimate at signing time. No WASM is used here. */
export function usdcxSponsorshipApprovalOf(transaction: ITransaction): UsdcxSponsorshipApproval | undefined {
  if (transaction.type !== 'bridged-send' || transaction.extraInputs?.provider !== 'usdcx') return undefined;
  const ids = transaction.approvedOutputNoteIds;
  if (ids?.length !== 1) return undefined;
  const burn = transaction.extraInputs.usdcxBurn;
  if (
    typeof burn?.noteId !== 'string' ||
    burn.noteId.toLowerCase() !== ids[0]?.toLowerCase() ||
    typeof transaction.faucetId !== 'string' ||
    transaction.faucetId.length === 0
  ) throw new Error('The USDCx burn has no matching approved note');
  const budget = burn.networkFeeBudget;
  if (!isCurrentUsdcxFeeBudget(budget)) throw new Error('The USDCx burn has no current reviewed native fee budget');
  return { accountId: transaction.accountId, faucetId: transaction.faucetId, noteId: burn.noteId, budget };
}

export function isCurrentUsdcxFeeBudget(
  budget: IUsdcxNetworkFeeBudget | undefined
): budget is IUsdcxNetworkFeeBudget {
  return !!budget &&
    typeof budget.faucetId === 'string' && budget.faucetId.length > 0 &&
    typeof budget.maxAmount === 'string' && /^(0|[1-9]\d{0,18})$/.test(budget.maxAmount) &&
    budget.scope === currentUsdcxFeeScope() &&
    budget.faucetId === getNativeAssetIdSync() &&
    budget.faucetId === getSdkSyncedNativeAssetIdSync();
}

/** Runs inside the existing decode hold; only one fully bound, budgeted companion is a fee. */
export function partitionApprovedUsdcxSponsorship<T extends SponsorshipNote>(
  createdNotes: T[],
  fee: AssetAmount | undefined,
  approval: UsdcxSponsorshipApproval | undefined
): { createdNotes: T[]; fee: AssetAmount | undefined } {
  if (!approval) return { createdNotes, fee };
  if (createdNotes.filter(note => note.id.toLowerCase() === approval.noteId.toLowerCase()).length !== 1) {
    throw new Error('The approved USDCx burn is missing from the fee-bearing transaction');
  }
  if (fee && (fee.faucetId !== approval.budget.faucetId || fee.amount < 0n)) {
    throw new Error('The verification fee is outside the reviewed native budget');
  }
  const candidates = createdNotes.filter(note => {
    if (note.id.toLowerCase() === approval.noteId.toLowerCase() || note.opaque || note.nfts.length !== 0) return false;
    const asset = note.amounts[0];
    if (note.amounts.length !== 1 || !asset || asset.faucetId !== approval.budget.faucetId || asset.amount <= 0n) {
      return false;
    }
    const expected = canonicalFeeSponsorshipNoteId({
      senderAccountId: canonicalWalletAccountId(approval.accountId),
      targetAccountId: canonicalWalletAccountId(approval.faucetId),
      featureNoteId: approval.noteId,
      feeFaucetId: canonicalWalletAccountId(approval.budget.faucetId)
    }, asset.amount);
    return note.id.toLowerCase() === expected.toLowerCase();
  });
  if (candidates.length > 1) throw new Error('The USDCx sponsorship is ambiguous');
  const companion = candidates[0];
  const amount = (fee?.amount ?? 0n) + (companion?.amounts[0]?.amount ?? 0n);
  if (amount > BigInt(approval.budget.maxAmount)) throw new Error('The native fee exceeds its reviewed budget');
  return {
    createdNotes: companion ? createdNotes.filter(note => note !== companion) : createdNotes,
    fee: amount === 0n ? undefined : { faucetId: approval.budget.faucetId, amount }
  };
}
