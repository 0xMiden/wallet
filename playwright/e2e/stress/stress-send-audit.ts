import type { Page } from '@playwright/test';

import { TxStatus, type TransactionRowSnapshot } from '../helpers/history';
import type { StressOpRecord } from './stress-driver';

type Wallet = 'A' | 'B';

type SendRow = Pick<TransactionRowSnapshot, 'id' | 'type' | 'status' | 'transactionId'>;

/** Inspect only the wallet rows named by the driver receipts. */
export function readStressSendRows(
  page: Page,
  operations: StressOpRecord[],
  wallet: Wallet
): Promise<SendRow[] | null> {
  const ids = new Set<string>();
  for (const op of operations) {
    const id = op.sender === wallet ? op.rowId : op.secondaryRowId;
    if (id) ids.add(id);
  }
  return page.evaluate(
    async rowIds => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open('TridentMain');
        open.onupgradeneeded = () => open.transaction?.abort();
        open.onerror = () => reject(open.error);
        open.onsuccess = () => resolve(open.result);
      });
      try {
        if (!db.objectStoreNames.contains('transactions')) return null;
        const store = db.transaction('transactions', 'readonly').objectStore('transactions');
        const rows = await Promise.all(
          rowIds.map(
            id =>
              new Promise<SendRow | null>((resolve, reject) => {
                const request = store.get(id);
                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                  const row = request.result;
                  resolve(
                    row ? { id: row.id, type: row.type, status: row.status, transactionId: row.transactionId } : null
                  );
                };
              })
          )
        );
        return rows.filter((row): row is SendRow => row !== null);
      } finally {
        db.close();
      }
    },
    [...ids]
  );
}

export function auditStressSends(operations: StressOpRecord[], rows: Record<Wallet, SendRow[]>) {
  const indexed = {
    A: new Map(rows.A.map(row => [row.id, row])),
    B: new Map(rows.B.map(row => [row.id, row]))
  };
  const seen = new Set<string>();
  const transactionIds = new Set<string>();
  const links: {
    operation: number;
    wallet: Wallet;
    leg: 'primary' | 'secondary';
    driverAccepted: boolean;
    rowId?: string;
    transactionId?: string;
    outcome: 'completed' | 'failed' | 'pending' | 'unlinked' | 'duplicate';
  }[] = [];

  for (const op of operations) {
    const receiver = op.receiver;
    const attempts = [
      { wallet: op.sender, leg: 'primary' as const, accepted: op.status === 'ok', rowId: op.rowId },
      { wallet: receiver, leg: 'secondary' as const, accepted: op.secondaryStatus === 'ok', rowId: op.secondaryRowId }
    ];
    for (const { wallet, leg, accepted, rowId } of attempts) {
      if (!accepted && !rowId) continue;
      const row = rowId && indexed[wallet].get(rowId);
      const key = rowId && `${wallet}:${rowId}`;
      const txId = row && row.transactionId;
      let outcome: (typeof links)[number]['outcome'] = 'unlinked';
      if (row && row.type === 'send' && key) {
        if (seen.has(key) || (txId && transactionIds.has(txId))) {
          outcome = 'duplicate';
        } else {
          seen.add(key);
          if (row.status === TxStatus.Completed && txId) {
            transactionIds.add(txId);
            outcome = 'completed';
          } else if (row.status === TxStatus.Failed) {
            outcome = 'failed';
          } else {
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
        transactionId: txId || undefined,
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
