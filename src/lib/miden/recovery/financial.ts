import type Dexie from 'dexie';

import { StorageContinuityError } from './continuity';
import { JOURNAL_MAX_ENTRIES } from './journal';
import { matchesRecoveryDebit, resolveRecoveryDebit } from './retry-transition';
import { toSerializable } from './serialization';
import type { RecoveryDebitEntry, RecoveryEntry, RecoveryPolicyEntry } from './types';
import { ITransaction, ITransactionStatus } from '../db/types';
import * as Repo from '../repo';
import { sameWalletAccountId } from '../sdk/helpers';
import { canonicalSpendingLimitIdentity } from '../spending-limits/identity';
import {
  parsePersistedSpendingLimit,
  toPersistedSpendingLimit,
  type PersistedSpendingLimit
} from '../spending-limits/types';
import { MAX_WINDOW_SECONDS } from '../spending-limits/window';

const outgoing = new Set(['send', 'swap', 'bridged-send', 'earn-deposit', 'execute']);
const counted = new Set([
  ITransactionStatus.Queued,
  ITransactionStatus.GeneratingTransaction,
  ITransactionStatus.Completed,
  ITransactionStatus.Failed,
  ITransactionStatus.Unconfirmed
]);

export function recoveryDebit(row: ITransaction, accountId: string, now: number): RecoveryDebitEntry | undefined {
  if (
    row.restoredFromBackup ||
    !outgoing.has(row.type) ||
    (row.spentUsd === undefined && row.spendingLimitAuthorizationId === undefined)
  )
    return undefined;
  if (!Number.isSafeInteger(row.initiatedAt) || row.initiatedAt < 0) throw new StorageContinuityError();
  if (row.initiatedAt < now - MAX_WINDOW_SECONDS) return undefined;
  if (
    !counted.has(row.status) ||
    (row.spentUsd !== undefined && (typeof row.spentUsd !== 'bigint' || row.spentUsd < 0n))
  )
    throw new StorageContinuityError();
  return {
    kind: 'debit',
    id: row.id,
    accountId,
    initiatedAt: row.initiatedAt,
    ...(row.spentUsd === undefined ? {} : { spentUsd: row.spentUsd }),
    ...(row.spendingLimitAuthorizationId === undefined ? {} : { authorizationId: row.spendingLimitAuthorizationId })
  };
}

export async function readFinancialRecoveryBaseline(
  accountIds: string[],
  now = Math.floor(Date.now() / 1000),
  database: Dexie = Repo.db
): Promise<RecoveryEntry[]> {
  const transactions = database.table<ITransaction>('transactions');
  const spendingLimits = database.table<PersistedSpendingLimit>('spendingLimits');
  const recoveryDebits = database.table<RecoveryDebitEntry>('recoveryDebits');
  return database.transaction('r', transactions, spendingLimits, recoveryDebits, async () => {
    const entries: RecoveryEntry[] = [];
    for (const accountId of accountIds) {
      const row = await spendingLimits.get(canonicalSpendingLimitIdentity(accountId));
      const policy: RecoveryPolicyEntry = {
        kind: 'policy',
        id: accountId,
        accountId,
        configuration: row === undefined ? null : toPersistedSpendingLimit(parsePersistedSpendingLimit(row))
      };
      entries.push(policy);
    }
    const rows = await transactions
      .where('recoveryDebitAt')
      .aboveOrEqual(now - MAX_WINDOW_SECONDS)
      .limit(JOURNAL_MAX_ENTRIES + 1)
      .toArray();
    if (rows.length > JOURNAL_MAX_ENTRIES) throw new StorageContinuityError();
    for (const row of await historyWithRecoveryDebits(rows, now, database)) {
      const accountId = accountIds.find(id => sameWalletAccountId(id, row.accountId));
      if (accountId === undefined) throw new StorageContinuityError();
      const debit = recoveryDebit(row, accountId, now);
      if (debit) entries.push(debit);
    }
    if (entries.length > JOURNAL_MAX_ENTRIES) throw new StorageContinuityError();
    return entries;
  });
}

export function verifyFinancialRecoveryEntries(
  expected: RecoveryEntry[],
  observed: RecoveryEntry[],
  now = Math.floor(Date.now() / 1000)
): void {
  for (const entry of expected) {
    if (entry.kind !== 'policy' && entry.kind !== 'debit') continue;
    if (entry.kind === 'debit' && resolveRecoveryDebit(entry).initiatedAt < now - MAX_WINDOW_SECONDS) continue;
    const current = observed.find(item => item.kind === entry.kind && item.id === entry.id);
    if (entry.kind === 'debit' && current?.kind === 'debit' && matchesRecoveryDebit(entry, current)) continue;
    if (JSON.stringify(toSerializable(current)) !== JSON.stringify(toSerializable(entry)))
      throw new StorageContinuityError();
  }
}

export async function readRetainedFinancialEntries(
  expected: RecoveryEntry[],
  now = Math.floor(Date.now() / 1000),
  database: Dexie = Repo.db
): Promise<RecoveryEntry[]> {
  const transactions = database.table<ITransaction>('transactions');
  const spendingLimits = database.table<PersistedSpendingLimit>('spendingLimits');
  const recoveryDebits = database.table<RecoveryDebitEntry>('recoveryDebits');
  return database.transaction('r', transactions, spendingLimits, recoveryDebits, async () => {
    const found: RecoveryEntry[] = [];
    for (const entry of expected) {
      if (entry.kind === 'policy') {
        const config = await spendingLimits.get(canonicalSpendingLimitIdentity(entry.accountId));
        found.push({
          ...entry,
          configuration: config === undefined ? null : toPersistedSpendingLimit(parsePersistedSpendingLimit(config))
        });
      } else if (entry.kind === 'debit' && resolveRecoveryDebit(entry).initiatedAt >= now - MAX_WINDOW_SECONDS) {
        const row = await transactions.get(entry.id);
        if (row && !sameWalletAccountId(row.accountId, entry.accountId)) throw new StorageContinuityError();
        const debit =
          row && !row.restoredFromBackup
            ? recoveryDebit(row, entry.accountId, entry.retry ? 0 : now)
            : await recoveryDebits.get(entry.id);
        if (debit) found.push(debit);
      }
    }
    return found;
  });
}

export async function historyWithRecoveryDebits(
  rows: ITransaction[],
  now: number,
  database: Dexie = Repo.db
): Promise<ITransaction[]> {
  const retained = await database
    .table<RecoveryDebitEntry>('recoveryDebits')
    .where('initiatedAt')
    .aboveOrEqual(now - MAX_WINDOW_SECONDS)
    .limit(JOURNAL_MAX_ENTRIES + 1)
    .toArray();
  if (retained.length > JOURNAL_MAX_ENTRIES) throw new StorageContinuityError();
  const history = new Map(rows.map(row => [row.id, row]));
  for (const debit of retained) {
    const current = history.get(debit.id);
    if (current && !current.restoredFromBackup) continue;
    history.set(debit.id, {
      id: debit.id,
      accountId: debit.accountId,
      type: 'send',
      status: ITransactionStatus.Failed,
      initiatedAt: debit.initiatedAt,
      spentUsd: debit.spentUsd,
      spendingLimitAuthorizationId: debit.authorizationId,
      displayIcon: 'FAILED'
    });
  }
  return [...history.values()];
}
