/** Integration boundary only. No production issuer or claim endpoint is approved/configured. */
export interface ArcadeAccountScope {
  accountId: string;
  networkId: string;
}

export type WeeklyClaimStatus =
  | { kind: 'checking' }
  | { kind: 'eligible' }
  | { kind: 'receivable' }
  | { kind: 'claimed'; nextEligibleAt: string }
  | { kind: 'pending' }
  | { kind: 'failed' }
  | { kind: 'reclaimable'; reclaimHeight: number }
  | { kind: 'unavailable' };

export interface WeeklyClaimRecovery {
  operationId: string;
  allocationWeekStart: string;
}

export interface WeeklyClaimSnapshot {
  /** Authenticated older requests whose unused native budgets can be recovered. */
  recoveries?: WeeklyClaimRecovery[];
  /** Authenticated older receipts awaiting a separately approved consume. */
  receipts?: WeeklyClaimRecovery[];
  /** Authoritative allocation week, supplied only after the backend reads chain entitlement. */
  allocationWeekStart?: string;
  status: WeeklyClaimStatus;
  /** Formatted canonical GC amount; null means unread, never zero. No optimistic grant. */
  balance: string | null;
}

/** A backend quote for this account and allocation week; amounts are formatted native units. */
export interface WeeklyClaimReview {
  quoteId: string;
  mode: 'claim' | 'reclaim' | 'receive';
  nativeRefund?: string;
  allocationWeekStart: string;
  expiresAt: string;
  nativeSymbol: string;
  requestFee: string;
  issuerBudget: string;
  receiptFeeBudget: string;
}

/**
 * Backend prerequisite: https://github.com/0xMiden/wallet/issues/1691
 * A future adapter MUST authenticate the account, enforce 10 GC/account/calendar week on the
 * authority, and reconcile the same account/week across devices. Eligibility ignores GC balance; unspent
 * tokens carry over, missed weeks do not stack. No transfer restriction or game allowlist.
 * Claims and result posting have user-funded network fees; no app-funded subsidy.
 * prepare() may quarantine/import locally and simulate without queueing or submitting; submit() redeems the exact reviewed quote after explicit approval.
 * The backend binds each quote to the account/network/week and enforces its expiry. A local calendar is not authority.
 * `failed` means verified non-submission/failure, safe to retry; timeouts remain pending.
 * `claimed` requires confirmed GC delivery/receipt, not merely accepting a mint request.
 * read() must recover pending operations after unmount/reinstall; submit() must be idempotent.
 */
export interface WeeklyClaimService {
  read(scope: ArcadeAccountScope): Promise<WeeklyClaimSnapshot>;
  prepare(scope: ArcadeAccountScope, operationId?: string): Promise<WeeklyClaimReview>;
  submit(scope: ArcadeAccountScope, quoteId: string): Promise<WeeklyClaimSnapshot>;
}

export const unavailableWeeklyClaimService: WeeklyClaimService = {
  read: async () => ({ status: { kind: 'unavailable' }, balance: null }),
  prepare: async () => {
    throw new Error('Weekly GC claims are unavailable');
  },
  submit: async () => ({ status: { kind: 'unavailable' }, balance: null })
};

/** Display/test utility only: authoritative eligibility always comes from the service. */
export function nextWeeklyBoundary(now: Date): Date {
  const next = new Date(now);
  const days = (8 - next.getUTCDay()) % 7 || 7;
  next.setUTCDate(next.getUTCDate() + days);
  next.setUTCHours(0, 0, 0, 0);
  return next;
}
