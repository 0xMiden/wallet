import { ITransactionStatus, type ITransaction } from '../db/types';
import { importVaultKey } from '../passworder';
import * as Repo from '../repo';
import { getStorageHealth, markStorageUnavailable, withStorageRecoveryAccess } from '../storage-health';
import { RecoveryJournal, JOURNAL_MAX_ENTRIES, type RecoveryStorage } from './journal';
import { restoreWalletRecoveryRows } from './restore';
import { retireRecoveryNotes, type RecoveryRetirementContext } from './retirement';
import { projectRecoveryTransaction } from './transaction-record';
import { verifyRetainedTransactionRows } from './transaction-continuity';
import { receiptSnapshot, oneClickReceiptRow } from './testing/provider-receipts';
import type { RecoveryEntry, RecoveryJournalSnapshot, RecoveryTransactionEntry } from './types';
import { validateJournal } from './validation';

function ordinary(id = 'ordinary'): RecoveryTransactionEntry {
  return {
    kind: 'transaction', id, accountId: 'account-a', requestBytes: new Uint8Array([1]), mayHaveSubmitted: true,
    evidence: { transactionId: `chain-${id}`, outputNoteIds: [`note-${id}`], nullifiers: [] },
    resolved: { outcome: 'landed', at: 10, transactionId: `chain-${id}` },
    row: {
      id, accountId: 'account-a', type: 'send', status: ITransactionStatus.Completed, initiatedAt: 1,
      displayIcon: 'SEND', noteType: 'public', inputNoteIds: [], outputNoteIds: [`note-${id}`],
      transactionId: `chain-${id}`, noteDelivery: 'confirmed'
    }
  };
}
const critical = (): RecoveryEntry => ({
  kind: 'debit', id: 'critical', accountId: 'account-a', initiatedAt: Math.floor(Date.now() / 1000) + 100,
  spentUsd: 7n, authorizationId: 'used-grant'
});
function snapshot(entries: RecoveryEntry[]): RecoveryJournalSnapshot {
  return validateJournal({
    version: 1, sequence: 1, scope: { network: 'network', walletGeneration: 'wallet', sdkGeneration: 'sdk' },
    accounts: [{ accountId: 'account-a', nonce: '1', commitment: 'state' }], entries
  });
}
function retirement(source: RecoveryJournalSnapshot, retain: RecoveryRetirementContext['retain']): RecoveryRetirementContext {
  return {
    snapshot: source, deadline: Date.now() + 5000, assertCurrent: () => {}, retain,
    reads: { identity: async () => undefined, header: async () => undefined, scan: async () => [] }
  };
}
class MemoryStorage implements RecoveryStorage {
  values: Record<string, unknown> = {};
  async get(keys: string[]) { return Object.fromEntries(keys.map(key => [key, this.values[key]])); }
  async set(values: Record<string, unknown>) { Object.assign(this.values, values); }
}
async function journal() {
  const key = await importVaultKey(new Uint8Array(32).fill(5));
  return new RecoveryJournal(key, new MemoryStorage());
}

let lockTail: Promise<unknown> = Promise.resolve();
Object.defineProperty(navigator, 'locks', {
  configurable: true,
  value: { request: (_name: string, operation: () => Promise<unknown>) => {
    const result = lockTail.then(operation);
    lockTail = result.catch(() => {});
    return result;
  } }
});
beforeEach(async () => { await Repo.db.open(); });

it('Task4C2 lifecycle retires canonically settled ordinary evidence while preserving its future debit and used grant', async () => {
  const source = snapshot([ordinary(), critical()]);
  let saved: RecoveryEntry[] = source.entries;
  expect(await retireRecoveryNotes(retirement(source, async entries => { saved = entries; }))).toBe(1);
  expect(saved.map(entry => entry.kind)).toEqual(['debit']);
  expect(saved[0]).toEqual(source.entries[1]);
});

it('Task4C2 lifecycle retains local Completed flags pending providers and incomplete private dependencies', async () => {
  const completed = ordinary('completed');
  delete completed.resolved;
  const privateSend = ordinary('private');
  privateSend.row = { ...privateSend.row!, noteType: 'private', noteDelivery: 'pending' };
  const provider = ordinary('provider');
  provider.row = { ...provider.row!, type: 'bridged-send', extraInputs: { provider: 'epoch', intentNonce: '22', claimStatus: 'pending' } };
  delete provider.resolved;
  const structural = ordinary('structural');
  structural.row = { ...structural.row!, type: 'switch-guardian' };
  const source = snapshot([completed, privateSend, provider, structural]);
  const retain = jest.fn();
  expect(await retireRecoveryNotes(retirement(source, retain))).toBe(0);
  expect(retain).not.toHaveBeenCalled();
});

it('Task4C2 lifecycle replaces resolved outbound evidence with its provider receipt in one verified generation', async () => {
  const entry = ordinary();
  entry.row = { ...entry.row!, type: 'bridged-send', extraInputs: { provider: 'epoch', intentNonce: '22', claimStatus: 'pending' } };
  const store = await journal();
  let current = await store.update(() => snapshot([entry, critical()]));
  const initialSequence = current.sequence;
  expect(await retireRecoveryNotes(retirement(current, async entries => {
    current = await store.replaceEntries(current, entries, () => {});
  }))).toBe(1);
  const retained = await store.read();
  expect(retained?.sequence).toBe(initialSequence + 1);
  expect(retained?.entries.map(item => item.kind)).toEqual(['receipt', 'debit']);
  const receipt = retained?.entries[0];
  expect(receipt?.kind === 'receipt' && receipt.row.extraInputs?.intentNonce).toBe('22');
});

it('Task4C2 lifecycle reuses bounded journal capacity across more than 256 settled ordinary transactions', async () => {
  const store = await journal();
  const preserved = critical();
  let current = await store.update(() => snapshot([preserved]));
  for (let index = 0; index < JOURNAL_MAX_ENTRIES + 3; index++) {
    current = await store.update(() => ({ ...current, entries: [ordinary(`activity-${index}`)] }));
    await retireRecoveryNotes(retirement(current, async entries => {
      current = await store.replaceEntries(current, entries, () => {});
    }));
  }
  const retained = await store.read();
  expect(retained?.entries).toHaveLength(1);
  expect(retained?.entries[0]?.kind).toBe('debit');
  expect(retained?.entries[0]).toEqual(preserved);
});

it('Task4C2 lifecycle refuses a genuinely full critical set without evicting reservations or used grants', async () => {
  const store = await journal();
  const entries = Array.from({ length: JOURNAL_MAX_ENTRIES }, (_, index) => ({ ...critical(), id: `critical-${index}` }));
  const first = await store.update(() => snapshot(entries));
  await expect(store.update(() => ({ ...first, entries: [ordinary()] }))).rejects.toThrow();
  expect((await store.read())?.entries).toHaveLength(JOURNAL_MAX_ENTRIES);
  expect((await store.read())?.sequence).toBe(first.sequence);
});

it.each(['missing row', 'lost provider binding'])('Task4C2 lifecycle detects receipt continuity loss for %s', async loss => {
  const row = oneClickReceiptRow();
  const source = validateJournal(receiptSnapshot(row));
  if (loss === 'lost provider binding') {
    row.extraInputs.oneClick.depositMemo = 'wrong-memo';
    await Repo.transactions.put(row);
  }
  await expect(verifyRetainedTransactionRows(source.entries)).rejects.toMatchObject({ name: 'StorageContinuityError' });
});

it('Task4C2 lifecycle never upgrades an external imported row through a retained receipt and later restore', async () => {
  const row: ITransaction = { ...oneClickReceiptRow(), restoredFromBackup: true };
  row.extraInputs = projectRecoveryTransaction(row).extraInputs;
  await Repo.transactions.put(row);
  const saved = await Repo.transactions.get(row.id);
  if (!saved) throw new Error('Missing imported fixture');
  const earlierLocal = validateJournal(receiptSnapshot({ ...saved, restoredFromBackup: undefined }));
  markStorageUnavailable('continuity', { backend: 'wallet', operation: 'validate' });
  await withStorageRecoveryAccess(getStorageHealth().epoch, Date.now() + 5000, async capability => {
    await restoreWalletRecoveryRows(earlierLocal, capability);
    const restored = await Repo.transactions.get(row.id);
    expect(restored?.restoredFromJournal).toBeUndefined();
    if (!restored) throw new Error('Missing restored row');
    const later = validateJournal({ ...earlierLocal, entries: [{ kind: 'receipt', id: row.id, accountId: row.accountId, row: projectRecoveryTransaction(restored) }] });
    await Repo.transactions.delete(row.id);
    await restoreWalletRecoveryRows(later, capability);
  });
  expect((await Repo.transactions.get(row.id))?.restoredFromJournal).toBeUndefined();
  expect((await Repo.transactions.get(row.id))?.restoredFromBackup).toBe(true);
});
