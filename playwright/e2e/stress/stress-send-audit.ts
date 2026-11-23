import type { StressOpRecord } from './stress-driver';
import { TxStatus, type TransactionRowSnapshot } from '../helpers/history';

type Wallet = 'A' | 'B';

type SendRow = Pick<TransactionRowSnapshot, 'id' | 'type' | 'status' | 'transactionId'>;

export type StressSendOutcome = 'completed' | 'failed' | 'pending' | 'unlinked' | 'duplicate';

export interface StressSendLink {
  operation: number;
  wallet: Wallet;
  leg: 'primary' | 'secondary';
  driverAccepted: boolean;
  rowId?: string;
  transactionId?: string;
  outcome: StressSendOutcome;
}

export interface StressSendAudit {
  confirmedPrimary: number;
  confirmedSecondary: number;
  links: StressSendLink[];
}

export interface StressSendAuditPolicy {
  conservationStrict: boolean;
  maxFailedSendRate: number;
}

export interface StressSendAuditEvaluation {
  duplicateLinks: StressSendLink[];
  unlinkedLinks: StressSendLink[];
  pendingLinks: StressSendLink[];
  disallowedPendingLinks: StressSendLink[];
  failedAcceptedLinks: StressSendLink[];
  acceptedCount: number;
  acceptedPrimary: number;
  acceptedSecondary: number;
  failedAcceptedRate: number;
  expectedConfirmedPrimary: number;
  expectedConfirmedSecondary: number;
  violations: string[];
  ok: boolean;
}

export function auditStressSends(operations: StressOpRecord[], rows: Record<Wallet, SendRow[]>): StressSendAudit {
  const indexed = {
    A: new Map(rows.A.map(row => [row.id, row])),
    B: new Map(rows.B.map(row => [row.id, row]))
  };
  const seen = new Set<string>();
  const transactionIds = new Set<string>();
  const links: StressSendLink[] = [];

  for (const op of operations) {
    const receiver = op.receiver;
    const attempts: { wallet: Wallet; leg: 'primary' | 'secondary'; accepted: boolean; rowId?: string }[] = [
      { wallet: op.sender, leg: 'primary', accepted: op.status === 'ok', rowId: op.rowId },
      { wallet: receiver, leg: 'secondary', accepted: op.secondaryStatus === 'ok', rowId: op.secondaryRowId }
    ];
    for (const { wallet, leg, accepted, rowId } of attempts) {
      if (!accepted && !rowId) continue;
      const row = rowId ? indexed[wallet].get(rowId) : undefined;
      const key = rowId ? `${wallet}:${rowId}` : undefined;
      const txId = row?.transactionId?.trim() || undefined;
      let outcome: StressSendOutcome = 'unlinked';
      if (row && row.type === 'send' && key) {
        if (seen.has(key) || (txId && transactionIds.has(txId))) {
          outcome = 'duplicate';
        } else {
          seen.add(key);
          if (txId) {
            transactionIds.add(txId);
          }
          if (row.status === TxStatus.Completed) {
            if (txId) {
              outcome = 'completed';
            }
          } else if (row.status === TxStatus.Failed) {
            outcome = 'failed';
          } else if (
            row.status === TxStatus.Queued ||
            row.status === TxStatus.GeneratingTransaction ||
            row.status === TxStatus.Unconfirmed
          ) {
            outcome = 'pending';
          }
        }
      }
      links.push({
        operation: op.idx,
        wallet,
        leg,
        driverAccepted: accepted,
        rowId,
        transactionId: txId,
        outcome
      });
    }
  }

  return {
    confirmedPrimary: links.filter(
      link => link.leg === 'primary' && link.driverAccepted && link.outcome === 'completed'
    ).length,
    confirmedSecondary: links.filter(
      link => link.leg === 'secondary' && link.driverAccepted && link.outcome === 'completed'
    ).length,
    links
  };
}

export function evaluateStressSendAudit(
  audit: StressSendAudit,
  policy: StressSendAuditPolicy
): StressSendAuditEvaluation {
  if (!(policy.maxFailedSendRate >= 0 && policy.maxFailedSendRate <= 1)) {
    throw new Error(`maxFailedSendRate=${policy.maxFailedSendRate} is not a rate in [0,1]`);
  }

  const duplicateLinks = audit.links.filter(link => link.outcome === 'duplicate');
  const unlinkedLinks = audit.links.filter(link => link.outcome === 'unlinked');
  const pendingLinks = audit.links.filter(link => link.outcome === 'pending');
  const disallowedPendingLinks = policy.conservationStrict ? pendingLinks : [];

  const acceptedLinks = audit.links.filter(link => link.driverAccepted);
  const acceptedPrimaryLinks = acceptedLinks.filter(link => link.leg === 'primary');
  const acceptedSecondaryLinks = acceptedLinks.filter(link => link.leg === 'secondary');
  const failedAcceptedLinks = acceptedLinks.filter(link => link.outcome === 'failed');
  const failedAcceptedRate = failedAcceptedLinks.length / Math.max(acceptedLinks.length, 1);
  const failedRateWithinBudget = failedAcceptedRate <= policy.maxFailedSendRate;

  const toleratedPendingPrimary = policy.conservationStrict
    ? 0
    : acceptedPrimaryLinks.filter(link => link.outcome === 'pending').length;
  const toleratedPendingSecondary = policy.conservationStrict
    ? 0
    : acceptedSecondaryLinks.filter(link => link.outcome === 'pending').length;
  const toleratedFailedPrimary = failedRateWithinBudget
    ? acceptedPrimaryLinks.filter(link => link.outcome === 'failed').length
    : 0;
  const toleratedFailedSecondary = failedRateWithinBudget
    ? acceptedSecondaryLinks.filter(link => link.outcome === 'failed').length
    : 0;

  const expectedConfirmedPrimary = acceptedPrimaryLinks.length - toleratedFailedPrimary - toleratedPendingPrimary;
  const expectedConfirmedSecondary =
    acceptedSecondaryLinks.length - toleratedFailedSecondary - toleratedPendingSecondary;

  const violations: string[] = [];
  if (duplicateLinks.length > 0) {
    violations.push(`${duplicateLinks.length} duplicate send link(s)`);
  }
  if (unlinkedLinks.length > 0) {
    violations.push(`${unlinkedLinks.length} unlinked send link(s)`);
  }
  if (disallowedPendingLinks.length > 0) {
    violations.push(`${disallowedPendingLinks.length} pending send link(s) under strict conservation`);
  }
  if (!failedRateWithinBudget) {
    violations.push(
      `accepted failed send rate ${failedAcceptedLinks.length}/${acceptedLinks.length} ` +
        `(${(100 * failedAcceptedRate).toFixed(1)}%) exceeds ${(100 * policy.maxFailedSendRate).toFixed(1)}%`
    );
  }
  if (audit.confirmedPrimary !== expectedConfirmedPrimary) {
    violations.push(`confirmedPrimary=${audit.confirmedPrimary} does not match expected ${expectedConfirmedPrimary}`);
  }
  if (audit.confirmedSecondary !== expectedConfirmedSecondary) {
    violations.push(
      `confirmedSecondary=${audit.confirmedSecondary} does not match expected ${expectedConfirmedSecondary}`
    );
  }

  return {
    duplicateLinks,
    unlinkedLinks,
    pendingLinks,
    disallowedPendingLinks,
    failedAcceptedLinks,
    acceptedCount: acceptedLinks.length,
    acceptedPrimary: acceptedPrimaryLinks.length,
    acceptedSecondary: acceptedSecondaryLinks.length,
    failedAcceptedRate,
    expectedConfirmedPrimary,
    expectedConfirmedSecondary,
    violations,
    ok: violations.length === 0
  };
}
