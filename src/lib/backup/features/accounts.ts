/**
 * The `accounts` feature: one entry per HD account, keyed `<type>:<hdIndex>`,
 * holding the #850 account object `{ v, i, t, n, nlu, as, ge, dt }`.
 *
 * - Imported accounts (`hdIndex` -1) are left out: the phrase cannot derive
 *   their keys.
 * - The name merges by `nlu`: the latest rename wins. A name this device has
 *   never seen change has `nlu` 0, so a peer's copy wins over it.
 * - `dt` is a tombstone. The wallet cannot hide an account yet, so this device
 *   writes `null` and does not apply a peer's account it does not hold.
 */
import { ACCOUNT_NAME_PATTERN } from 'app/defaults';
import { getAccountsWriteQueue } from 'lib/miden/back/accounts-write-queue';
import { accountsUpdated } from 'lib/miden/back/store';
import type { AuthScheme, WalletAccount } from 'lib/shared/types';
import { isRecord } from 'lib/update/guards';
import { WalletType } from 'screens/onboarding/types';

import { type IncomingEntry, type OutgoingEntry, readFeature, uploadEntries } from '../entries';
import { type BackupSession, assertSessionLive, persistMergeRecords } from '../session';

/** The #850 type codes. */
export type AccountTypeCode = 'onchain' | 'offchain' | 'guardian';

/** The #850 account object, version 1. */
export interface AccountEntry {
  v: 1;
  i: number;
  t: AccountTypeCode;
  n: string;
  nlu: number;
  as: AuthScheme;
  ge: string | null;
  dt: number | null;
}

export function accountTypeCode(type: WalletType): AccountTypeCode {
  switch (type) {
    case WalletType.OnChain:
      return 'onchain';
    case WalletType.OffChain:
      return 'offchain';
    case WalletType.Guardian:
      return 'guardian';
  }
}

/** The entry key of an account before hashing, such as `guardian:3`. */
export function accountEntryKey(type: AccountTypeCode, hdIndex: number): string {
  return `${type}:${hdIndex}`;
}

/** True for an account the phrase derives, the only kind this feature syncs. */
export function isSyncedAccount(account: WalletAccount): boolean {
  return Number.isSafeInteger(account.hdIndex) && account.hdIndex >= 0;
}

/** Project a wallet account to its entry. `nlu` comes from the caller's name record. */
export function projectAccount(account: WalletAccount, nlu: number): AccountEntry {
  return {
    v: 1,
    i: account.hdIndex,
    t: accountTypeCode(account.type),
    n: account.name,
    nlu,
    as: account.authScheme,
    ge: account.type === WalletType.Guardian ? (account.guardianEndpoint ?? null) : null,
    dt: null
  };
}

function readTypeCode(value: unknown): AccountTypeCode | null {
  switch (value) {
    case 'onchain':
    case 'offchain':
    case 'guardian':
      return value;
    default:
      return null;
  }
}

function readAuthScheme(value: unknown): AuthScheme | null {
  switch (value) {
    case 'falcon':
    case 'ecdsa':
      return value;
    default:
      return null;
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Parse one decrypted account entry. Null for any other shape. */
export function parseAccountEntry(plaintext: string): AccountEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.v !== 1) return null;
  const t = readTypeCode(value.t);
  const as = readAuthScheme(value.as);
  const { i, n, nlu, ge, dt } = value;
  if (t === null || as === null || !isNonNegativeInteger(i) || typeof n !== 'string' || !isNonNegativeInteger(nlu)) {
    return null;
  }
  if (ge !== null && typeof ge !== 'string') return null;
  if (dt !== null && !isNonNegativeInteger(dt)) return null;
  return { v: 1, i, t, n, nlu, as, ge, dt };
}

/** The name record of an account: first sight records the current name with `nlu` 0; a changed name is a rename now. */
function nameMarkOf(session: BackupSession, key: string, name: string): { name: string; nlu: number } {
  const mark = session.merge.accountNames[key];
  if (mark === undefined) {
    const created = { name, nlu: 0 };
    session.merge.accountNames[key] = created;
    return created;
  }
  if (mark.name !== name) {
    mark.name = name;
    mark.nlu = Date.now();
  }
  return mark;
}

/** Apply peer entries: a newer name renames the local account. */
async function applyAccountEntries(session: BackupSession, entries: readonly IncomingEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const parsed = entries.map(entry => parseAccountEntry(entry.plaintext)).filter(entry => entry !== null);
  if (parsed.length === 0) return;
  await getAccountsWriteQueue().add(async () => {
    // The queue wait may have outlived the unlock: a closed session renames nothing.
    assertSessionLive(session);
    const accounts = await session.vault.fetchAccounts();
    for (const remote of parsed) {
      if (remote.dt !== null) continue;
      const local = accounts.find(
        account =>
          isSyncedAccount(account) && account.hdIndex === remote.i && accountTypeCode(account.type) === remote.t
      );
      // An account a peer holds and this device does not: creating it is a restore step, not built here.
      if (local === undefined) continue;
      const key = accountEntryKey(remote.t, remote.i);
      const mark = nameMarkOf(session, key, local.name);
      if (remote.n === local.name || remote.nlu < mark.nlu || !ACCOUNT_NAME_PATTERN.test(remote.n)) continue;
      try {
        const updated = await session.vault.editAccountName(local.publicKey, remote.n);
        accountsUpdated(updated);
        mark.name = remote.n;
        mark.nlu = remote.nlu;
      } catch (error) {
        // Another local account holds that name. The local name stays and is uploaded.
        console.warn('[backup] a synced account name was not applied', error);
      }
    }
  });
  await persistMergeRecords(session);
}

/** The outgoing entry of every synced local account. */
async function outgoingAccounts(session: BackupSession): Promise<OutgoingEntry[]> {
  const accounts = await session.vault.fetchAccounts();
  const outgoing: OutgoingEntry[] = [];
  for (const account of accounts) {
    if (!isSyncedAccount(account)) continue;
    const type = accountTypeCode(account.type);
    const key = accountEntryKey(type, account.hdIndex);
    const mark = nameMarkOf(session, key, account.name);
    outgoing.push({ entryKey: key, plaintext: JSON.stringify(projectAccount(account, mark.nlu)) });
  }
  await persistMergeRecords(session);
  return outgoing;
}

/** Read the peer entries (unless `read` is false) and upload the changed local ones. */
export async function syncAccounts(session: BackupSession, read: boolean): Promise<boolean> {
  let changed = false;
  // A device that never read the feature must not write over a peer's newer names.
  if (read || session.state.features.accounts.etag === null) {
    const outcome = await readFeature(session, 'accounts', {
      since: false,
      apply: entries => applyAccountEntries(session, entries)
    });
    changed = outcome === 'applied';
  }
  await uploadEntries(session, 'accounts', await outgoingAccounts(session));
  return changed;
}
