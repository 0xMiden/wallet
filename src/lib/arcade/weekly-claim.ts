/** Integration boundary only. No production issuer or claim endpoint is approved/configured. */
export interface ArcadeAccountScope {
  accountId: string;
  networkId: string;
}

export type WeeklyClaimStatus =
  | { kind: 'eligible' }
  | { kind: 'claimed'; nextEligibleAt: string }
  | { kind: 'pending' }
  | { kind: 'failed' }
  | { kind: 'unavailable' };

export interface WeeklyClaimSnapshot {
  status: WeeklyClaimStatus;
  /** Formatted canonical GC amount; null means unread, never zero. No optimistic grant. */
  balance: string | null;
}

/**
 * Backend prerequisite: https://github.com/0xMiden/wallet/issues/1691
 * A future adapter MUST authenticate the account, enforce 10 GC/account/calendar week on the
 * authority, and reconcile the same account/week across devices. Eligibility ignores GC balance; unspent
 * tokens carry over, missed weeks do not stack. No transfer restriction or game allowlist.
 * Claims and result posting have user-funded network fees; no app-funded subsidy.
 * submit() must show actual fee estimation and wallet approval before any user-funded write. A local calendar is not authority.
 * `failed` means verified non-submission/failure, safe to retry; timeouts remain pending.
 * `claimed` requires confirmed GC delivery/receipt, not merely accepting a mint request.
 * read() must recover pending operations after unmount/reinstall; submit() must be idempotent.
 */
export interface WeeklyClaimService {
  read(scope: ArcadeAccountScope): Promise<WeeklyClaimSnapshot>;
  submit(scope: ArcadeAccountScope): Promise<WeeklyClaimSnapshot>;
}

export const unavailableWeeklyClaimService: WeeklyClaimService = {
  read: async () => ({ status: { kind: 'unavailable' }, balance: null }),
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
