import type { AssetAmount, ViewNote } from 'app/confirm/decode';
import type { IRegisterNameExtraInputs, ITransaction, IUsdcxNetworkFeeBudget } from 'lib/miden/db/types';
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

export interface RegisterNameSponsorshipApproval {
  kind: 'register-name';
  accountId: string;
  targetAccountId: string;
  noteId: string;
  feeFaucetId: string;
  maxAmount: string;
}

export type SponsorshipApproval = UsdcxSponsorshipApproval | RegisterNameSponsorshipApproval;

const isValidFeeAmountString = (amount: unknown): amount is string =>
  typeof amount === 'string' && /^(0|[1-9]\d{0,18})$/.test(amount);

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
  )
    throw new Error('The USDCx burn has no matching approved note');
  const budget = burn.networkFeeBudget;
  if (!isCurrentUsdcxFeeBudget(budget)) throw new Error('The USDCx burn has no current reviewed native fee budget');
  return { accountId: transaction.accountId, faucetId: transaction.faucetId, noteId: burn.noteId, budget };
}

/** Sponsorship approval for a `register-name` row: one companion targeted at the registry, capped at `networkFeeBaseUnits`. */
export function registerNameSponsorshipApprovalOf(
  transaction: ITransaction
): RegisterNameSponsorshipApproval | undefined {
  if (transaction.type !== 'register-name') return undefined;
  const ids = transaction.approvedOutputNoteIds;
  if (ids?.length !== 1) return undefined;
  const inputs: Partial<IRegisterNameExtraInputs> | undefined = transaction.extraInputs;
  if (
    typeof inputs?.registrationNoteId !== 'string' ||
    inputs.registrationNoteId.toLowerCase() !== ids[0]?.toLowerCase() ||
    typeof transaction.secondaryAccountId !== 'string' ||
    transaction.secondaryAccountId.length === 0
  ) {
    throw new Error('The registration has no matching approved note');
  }
  if (!isValidFeeAmountString(inputs.networkFeeBaseUnits)) {
    throw new Error('The registration has no reviewed native fee budget');
  }
  const feeFaucetId = getNativeAssetIdSync();
  if (!feeFaucetId) {
    throw new Error('The registration has no current native fee faucet');
  }
  return {
    kind: 'register-name',
    accountId: transaction.accountId,
    targetAccountId: transaction.secondaryAccountId,
    noteId: inputs.registrationNoteId,
    feeFaucetId,
    maxAmount: inputs.networkFeeBaseUnits
  };
}

/** Reviewed sponsorship approval for `transaction`, or undefined when its type carries no canonical sponsorship companion. */
export function sponsorshipApprovalOf(transaction: ITransaction): SponsorshipApproval | undefined {
  return usdcxSponsorshipApprovalOf(transaction) ?? registerNameSponsorshipApprovalOf(transaction);
}

export function isCurrentUsdcxFeeBudget(budget: IUsdcxNetworkFeeBudget | undefined): budget is IUsdcxNetworkFeeBudget {
  return (
    !!budget &&
    typeof budget.faucetId === 'string' &&
    budget.faucetId.length > 0 &&
    isValidFeeAmountString(budget.maxAmount) &&
    budget.scope === currentUsdcxFeeScope() &&
    budget.faucetId === getNativeAssetIdSync() &&
    budget.faucetId === getSdkSyncedNativeAssetIdSync()
  );
}

interface NormalizedSponsorshipApproval {
  accountId: string;
  targetAccountId: string;
  noteId: string;
  feeFaucetId: string;
  maxAmount: bigint;
  capKernelFee: boolean;
  missingNoteMessage: string;
  ambiguousMessage: string;
}

const normalizeSponsorshipApproval = (approval: SponsorshipApproval): NormalizedSponsorshipApproval => {
  if ('kind' in approval) {
    return {
      accountId: approval.accountId,
      targetAccountId: approval.targetAccountId,
      noteId: approval.noteId,
      feeFaucetId: approval.feeFaucetId,
      maxAmount: BigInt(approval.maxAmount),
      capKernelFee: false,
      missingNoteMessage: 'The approved registration note is missing from the fee-bearing transaction',
      ambiguousMessage: 'The registration sponsorship is ambiguous'
    };
  }
  return {
    accountId: approval.accountId,
    targetAccountId: approval.faucetId,
    noteId: approval.noteId,
    feeFaucetId: approval.budget.faucetId,
    maxAmount: BigInt(approval.budget.maxAmount),
    capKernelFee: true,
    missingNoteMessage: 'The approved USDCx burn is missing from the fee-bearing transaction',
    ambiguousMessage: 'The USDCx sponsorship is ambiguous'
  };
};

/** Runs inside the existing decode hold; only one fully bound, budgeted companion is a fee. */
export function partitionApprovedSponsorship<T extends SponsorshipNote>(
  createdNotes: T[],
  fee: AssetAmount | undefined,
  approval: SponsorshipApproval | undefined
): { createdNotes: T[]; fee: AssetAmount | undefined } {
  if (!approval) return { createdNotes, fee };
  const spec = normalizeSponsorshipApproval(approval);
  if (createdNotes.filter(note => note.id.toLowerCase() === spec.noteId.toLowerCase()).length !== 1) {
    throw new Error(spec.missingNoteMessage);
  }
  if (fee && (fee.faucetId !== spec.feeFaucetId || fee.amount < 0n)) {
    throw new Error('The verification fee is outside the reviewed native budget');
  }
  const candidates = createdNotes.filter(note => {
    if (note.id.toLowerCase() === spec.noteId.toLowerCase() || note.opaque || note.nfts.length !== 0) return false;
    const asset = note.amounts[0];
    if (note.amounts.length !== 1 || !asset || asset.faucetId !== spec.feeFaucetId || asset.amount <= 0n) {
      return false;
    }
    const expected = canonicalFeeSponsorshipNoteId(
      {
        senderAccountId: canonicalWalletAccountId(spec.accountId),
        targetAccountId: canonicalWalletAccountId(spec.targetAccountId),
        featureNoteId: spec.noteId,
        feeFaucetId: canonicalWalletAccountId(spec.feeFaucetId)
      },
      asset.amount
    );
    return note.id.toLowerCase() === expected.toLowerCase();
  });
  if (candidates.length > 1) throw new Error(spec.ambiguousMessage);
  const companion = candidates[0];
  const companionAmount = companion?.amounts[0]?.amount ?? 0n;
  const totalAmount = (fee?.amount ?? 0n) + companionAmount;
  // USDCx quotes a combined ceiling for kernel fee + companion; register-name quotes only the companion sponsorship.
  const cappedAmount = spec.capKernelFee ? totalAmount : companionAmount;
  if (cappedAmount > spec.maxAmount) throw new Error('The native fee exceeds its reviewed budget');
  return {
    createdNotes: companion ? createdNotes.filter(note => note !== companion) : createdNotes,
    fee: totalAmount === 0n ? undefined : { faucetId: spec.feeFaucetId, amount: totalAmount }
  };
}

/** Runs inside the existing decode hold; only one fully bound, budgeted USDCx companion is a fee. */
export function partitionApprovedUsdcxSponsorship<T extends SponsorshipNote>(
  createdNotes: T[],
  fee: AssetAmount | undefined,
  approval: UsdcxSponsorshipApproval | undefined
): { createdNotes: T[]; fee: AssetAmount | undefined } {
  return partitionApprovedSponsorship(createdNotes, fee, approval);
}
