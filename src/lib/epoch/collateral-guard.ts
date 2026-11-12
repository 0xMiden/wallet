import { getMessage } from 'lib/i18n';

import { normalizeMidenIdToHex } from './bridge';

/** The part of a collateral note request that does not agree with the review. */
export type CollateralNoteField = 'faucet' | 'amount' | 'allocator';

/**
 * The Epoch SDK asked for a collateral note that does not agree with the review. The wallet builds no note. The
 * message is the localized text that the review screen shows.
 */
export class EpochCollateralNoteMismatchError extends Error {
  constructor(readonly field: CollateralNoteField) {
    super(getMessage('epochCollateralNoteMismatch'));
    this.name = 'EpochCollateralNoteMismatchError';
  }
}

/** The values that the Epoch SDK gives to the `createMidenP2IDENote` callback. */
export interface CollateralNoteRequest {
  faucetId: string;
  /** Base units, as a decimal string. */
  amount: string;
  allocatorId: string;
}

/** The values that the user reviewed, and the allocator account that the wallet configuration names. */
export interface ReviewedCollateral {
  faucetId: string;
  amount: bigint;
  /** Null while the configuration names no allocator account. */
  allocatorAccountId: string | null;
}

// One account id in its lowercase hex form, so a hex id and a bech32 id of one account are equal.
const canonicalAccountId = (id: string): string => normalizeMidenIdToHex(id).toLowerCase();

const sameAccount = (a: string, b: string): boolean => {
  const first = canonicalAccountId(a);
  return first !== '' && first === canonicalAccountId(b);
};

/**
 * The first field of `request` that does not agree with `reviewed`, else null. The faucet must be the reviewed
 * faucet, the amount must be exactly the reviewed amount, and the allocator must be the account that the
 * configuration names.
 */
export function collateralNoteMismatch(
  request: CollateralNoteRequest,
  reviewed: ReviewedCollateral
): CollateralNoteField | null {
  if (!sameAccount(request.faucetId, reviewed.faucetId)) return 'faucet';
  if (request.amount !== reviewed.amount.toString()) return 'amount';
  if (reviewed.allocatorAccountId === null || !sameAccount(request.allocatorId, reviewed.allocatorAccountId)) {
    return 'allocator';
  }
  return null;
}
