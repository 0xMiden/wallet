import { ITransactionStatus, type ITransaction } from '../db/types';
import { importVaultKey } from '../passworder';
import * as Repo from '../repo';
import { getStorageHealth, markStorageUnavailable, withStorageRecoveryAccess } from '../storage-health';
import { captureRecoveryNotes } from './capture';
import { RecoveryJournal, JOURNAL_MAX_ENTRIES, type RecoveryStorage } from './journal';
import { reconcileRecoveryTransactions } from './reconcile';
import { restoreWalletRecoveryRows } from './restore';
import { retireRecoveryNotes, type RecoveryRetirementContext } from './retirement';
import { receiptSnapshot, oneClickReceiptRow } from './testing/provider-receipts';
import { verifyRetainedTransactionRows } from './transaction-continuity';
import { projectRecoveryTransaction } from './transaction-record';
import type { RecoveryEntry, RecoveryJournalSnapshot, RecoveryTransactionEntry } from './types';
import { validateJournal } from './validation';

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  ...jest.requireActual('../../../../__mocks__/wasmMock.js'),
  NoteType: { Private: 0, Public: 1 },
  NoteFile: {
    fromInputNote: (note: { bytes: Uint8Array }) => ({ serialize: () => note.bytes, free: () => {} }),
    fromOutputNote: (note: { bytes: Uint8Array }) => ({ serialize: () => note.bytes, free: () => {} })
  }
}));

function ordinary(id = 'ordinary'): RecoveryTransactionEntry {
  return {
    kind: 'transaction',
    id,
    accountId: 'account-a',
    requestBytes: new Uint8Array([1]),
    mayHaveSubmitted: true,
    evidence: { transactionId: `chain-${id}`, outputNoteIds: [`note-${id}`], nullifiers: [] },
    resolved: { outcome: 'landed', at: 10, transactionId: `chain-${id}` },
    row: {
      id,
      accountId: 'account-a',
      type: 'send',
      status: ITransactionStatus.Completed,
      initiatedAt: 1,
      displayIcon: 'SEND',
      noteType: 'public',
      inputNoteIds: [],
      outputNoteIds: [`note-${id}`],
      transactionId: `chain-${id}`,
      noteDelivery: 'confirmed'
    }
  };
}
const critical = (): RecoveryEntry => ({
  kind: 'debit',
  id: 'critical',
  accountId: 'account-a',
  initiatedAt: Math.floor(Date.now() / 1000) + 100,
  spentUsd: 7n,
  authorizationId: 'used-grant'
});
function snapshot(entries: RecoveryEntry[]): RecoveryJournalSnapshot {
  return validateJournal({
    version: 1,
    sequence: 1,
    scope: { network: 'network', walletGeneration: 'wallet', sdkGeneration: 'sdk' },
    accounts: [{ accountId: 'account-a', nonce: '1', commitment: 'state' }],
    entries
  });
}
function retirement(
  source: RecoveryJournalSnapshot,
  retain: RecoveryRetirementContext['retain']
): RecoveryRetirementContext {
  return {
    snapshot: source,
    deadline: Date.now() + 5000,
    assertCurrent: () => {},
    retain,
    reads: { identity: async () => undefined, header: async () => undefined, scan: async () => [] }
  };
}
class MemoryStorage implements RecoveryStorage {
  values: Record<string, unknown> = {};
  async get(keys: string[]) {
    return Object.fromEntries(keys.map(key => [key, this.values[key]]));
  }
  async set(values: Record<string, unknown>) {
    Object.assign(this.values, values);
  }
}
async function journal() {
  const key = await importVaultKey(new Uint8Array(32).fill(5));
  return new RecoveryJournal(key, new MemoryStorage());
}

let lockTail: Promise<unknown> = Promise.resolve();
Object.defineProperty(navigator, 'locks', {
  configurable: true,
  value: {
    request: (_name: string, operation: () => Promise<unknown>) => {
      const result = lockTail.then(operation);
      lockTail = result.catch(() => {});
      return result;
    }
  }
});
beforeEach(async () => {
  await Repo.db.open();
});

it('Task4C2 lifecycle retires canonically settled ordinary evidence while preserving its future debit and used grant', async () => {
  const source = snapshot([ordinary(), critical()]);
  let saved: RecoveryEntry[] = source.entries;
  expect(
    await retireRecoveryNotes(
      retirement(source, async entries => {
        saved = entries;
      })
    )
  ).toBe(1);
  expect(saved.map(entry => entry.kind)).toEqual(['debit']);
  expect(saved[0]).toEqual(source.entries[1]);
});

it('Task4C2 lifecycle retains local Completed flags pending providers and incomplete private dependencies', async () => {
  const completed = ordinary('completed');
  delete completed.resolved;
  const privateSend = ordinary('private');
  privateSend.row = { ...privateSend.row!, noteType: 'private', noteDelivery: 'pending' };
  const provider = ordinary('provider');
  provider.row = {
    ...provider.row!,
    type: 'bridged-send',
    extraInputs: { provider: 'epoch', intentNonce: '22', claimStatus: 'pending' }
  };
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
  entry.row = {
    ...entry.row!,
    type: 'bridged-send',
    extraInputs: { provider: 'epoch', intentNonce: '22', claimStatus: 'pending' }
  };
  const store = await journal();
  let current = await store.update(() => snapshot([entry, critical()]));
  const initialSequence = current.sequence;
  expect(
    await retireRecoveryNotes(
      retirement(current, async entries => {
        current = await store.replaceEntries(current, entries, () => {});
      })
    )
  ).toBe(1);
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
  const retain = async (entries: RecoveryEntry[]) => {
    current = await store.replaceEntries(current, entries, () => {});
  };
  for (let index = 0; index < JOURNAL_MAX_ENTRIES + 3; index++) {
    const previous = current;
    current = await store.update(() => ({ ...previous, entries: [ordinary(`activity-${index}`)] }));
    await retireRecoveryNotes(retirement(current, retain));
  }
  const retained = await store.read();
  expect(retained?.entries).toHaveLength(1);
  expect(retained?.entries[0]?.kind).toBe('debit');
  expect(retained?.entries[0]).toEqual(preserved);
});

it('Task4C2 lifecycle refuses a genuinely full critical set without evicting reservations or used grants', async () => {
  const store = await journal();
  const entries = Array.from({ length: JOURNAL_MAX_ENTRIES }, (_, index) => ({
    ...critical(),
    id: `critical-${index}`
  }));
  const first = await store.update(() => snapshot(entries));
  await expect(store.update(() => ({ ...first, entries: [ordinary()] }))).rejects.toThrow();
  expect((await store.read())?.entries).toHaveLength(JOURNAL_MAX_ENTRIES);
  expect((await store.read())?.sequence).toBe(first.sequence);
});

it('Task4C3 actual public capture reuses capacity without evicting unknown private bodies', async () => {
  const store = await journal();
  const preserved = critical();
  const unknown: RecoveryEntry = {
    kind: 'note',
    id: 'unknown-details',
    accountId: 'account-a',
    provenance: 'input',
    format: 'details',
    noteFile: new Uint8Array([9, 8, 7])
  };
  let current = await store.update(() => snapshot([preserved, unknown]));
  const retain = async (entries: RecoveryEntry[]) => {
    current = await store.replaceEntries(current, entries, () => {});
  };
  let completed = 0;
  let failure: unknown;
  try {
    for (let index = 0; index < JOURNAL_MAX_ENTRIES + 3; index++) {
      const entry = ordinary(`captured-${index}`);
      const executed = Object.assign(Object.create(null), {
        executedTransaction: () => ({
          inputNotes: () => ({ notes: () => [] }),
          userOutputNotes: () => [
            {
              id: () => ({ toString: () => `note-${entry.id}` }),
              bytes: new Uint8Array([1, 2, 3]),
              metadata: () => ({ noteType: () => 1 }),
              intoFull: () => ({ free: () => {} })
            }
          ]
        })
      });
      const capture = captureRecoveryNotes(executed, entry.requestBytes, () => true);
      const previous = current;
      current = await store.update(() => ({ ...previous, entries: [entry, ...capture.notes] }));
      await retireRecoveryNotes(retirement(current, retain));
      completed++;
    }
  } catch (error) {
    failure = error;
  }
  expect({ completed, failure }).toEqual({ completed: JOURNAL_MAX_ENTRIES + 3, failure: undefined });
  expect(completed).toBe(JOURNAL_MAX_ENTRIES + 3);
  expect((await store.read())?.entries).toEqual([preserved, unknown]);
});

it.each(['missing row', 'lost provider binding'])(
  'Task4C2 lifecycle detects receipt continuity loss for %s',
  async loss => {
    const row = oneClickReceiptRow();
    const source = validateJournal(receiptSnapshot(row));
    if (loss === 'lost provider binding') {
      row.extraInputs.oneClick.depositMemo = 'wrong-memo';
      await Repo.transactions.put(row);
    }
    await expect(verifyRetainedTransactionRows(source.entries)).rejects.toMatchObject({
      name: 'StorageContinuityError'
    });
  }
);

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
    const later = validateJournal({
      ...earlierLocal,
      entries: [{ kind: 'receipt', id: row.id, accountId: row.accountId, row: projectRecoveryTransaction(restored) }]
    });
    const recoveryStore = await Repo.openWalletRecoveryStore(capability);
    try {
      await recoveryStore.table('transactions').delete(row.id);
    } finally {
      recoveryStore.close();
    }
    await restoreWalletRecoveryRows(later, capability);
  });
  expect((await Repo.transactions.get(row.id))?.restoredFromJournal).toBeUndefined();
  expect((await Repo.transactions.get(row.id))?.restoredFromBackup).toBe(true);
});

it.each(['critical first', 'receipt first'])(
  'Task4C2 boundaries restore critical material and newer provider enrichment with %s',
  async ordering => {
    const criticalEntry = ordinary();
    criticalEntry.row = {
      ...criticalEntry.row!,
      type: 'bridged-send',
      extraInputs: { provider: 'epoch', intentNonce: '22', evmTxHash: 'hash-a' }
    };
    const receipt: RecoveryEntry = {
      kind: 'receipt',
      id: criticalEntry.id,
      accountId: criticalEntry.accountId,
      row: { ...criticalEntry.row, extraInputs: { ...criticalEntry.row.extraInputs, evmTxHash: 'hash-b' } }
    };
    const source = snapshot(ordering === 'critical first' ? [criticalEntry, receipt] : [receipt, criticalEntry]);
    markStorageUnavailable('continuity', { backend: 'wallet', operation: 'validate' });
    await expect(
      withStorageRecoveryAccess(getStorageHealth().epoch, Date.now() + 5000, capability =>
        restoreWalletRecoveryRows(source, capability)
      )
    ).resolves.toBeUndefined();
    const restored = await Repo.transactions.get(criticalEntry.id);
    expect(restored?.status).toBe(ITransactionStatus.Unconfirmed);
    expect(restored?.requestBytes && Array.from(restored.requestBytes)).toEqual([1]);
    expect(restored?.extraInputs.evmTxHash).toBe('hash-b');
    expect(restored?.extraInputs.intentNonce).toBe('22');
    expect(restored?.restoredFromJournal).toBe(true);
  }
);

it('Task4C2 expiry retires old settled charged history after its legitimate financial window', async () => {
  const entry = ordinary();
  if (!entry.row) throw new Error('Missing fixture row');
  entry.row.spentUsd = 7n;
  entry.row.spendingLimitAuthorizationId = 'expired-grant';
  const futureDebit = critical();
  let saved: RecoveryEntry[] = [];
  expect(
    await retireRecoveryNotes(
      retirement(snapshot([entry, futureDebit]), async entries => {
        saved = entries;
      })
    )
  ).toBe(1);
  expect(saved).toEqual([futureDebit]);
});
it('Task4C2 expiry retains current charged history when its independent debit is missing', async () => {
  const entry = ordinary();
  if (!entry.row) throw new Error('Missing fixture row');
  entry.row.initiatedAt = Math.floor(Date.now() / 1000) + 100;
  entry.row.spentUsd = 7n;
  entry.row.spendingLimitAuthorizationId = 'current-grant';
  const retain = jest.fn();
  expect(await retireRecoveryNotes(retirement(snapshot([entry]), retain))).toBe(0);
  expect(retain).not.toHaveBeenCalled();
});

it.each(['landed', 'indeterminate', 'retention failure'])(
  'Task4C2 cold loss restores encrypted submission and provider receipt before %s reconciliation',
  async outcome => {
    const id = `cold-${outcome}`;
    const row: ITransaction = {
      id,
      accountId: 'account-a',
      type: 'bridged-send',
      status: ITransactionStatus.Unconfirmed,
      initiatedAt: 1,
      displayIcon: 'SEND',
      requestBytes: new Uint8Array([1, 2, 3]),
      mayHaveSubmitted: true,
      extraInputs: { provider: 'epoch', intentNonce: '22', evmTxHash: 'old-hash' },
      submitEvidence: [
        {
          attemptId: id,
          capturedAt: 1,
          source: 'stage',
          transactionId: 'tx-hex',
          refBlock: 10,
          refBlockCommitment: 'header',
          initialCommitment: 'old',
          finalCommitment: 'new',
          initialNonce: '1',
          outputNoteIds: [],
          nullifiers: [],
          expirationBlock: 30
        }
      ]
    };
    const transaction: RecoveryTransactionEntry = {
      kind: 'transaction',
      id,
      accountId: row.accountId,
      requestBytes: row.requestBytes!,
      mayHaveSubmitted: true,
      evidence: {},
      row: projectRecoveryTransaction(row)
    };
    const receipt: RecoveryEntry = {
      kind: 'receipt',
      id,
      accountId: row.accountId,
      row: { ...transaction.row!, extraInputs: { ...row.extraInputs, evmTxHash: 'new-hash' } }
    };
    const storage = new MemoryStorage();
    const key = await importVaultKey(new Uint8Array(32).fill(5));
    const writer = new RecoveryJournal(key, storage);
    await writer.update(() => snapshot([transaction, receipt]));
    expect(JSON.stringify(storage.values)).not.toContain('new-hash');
    await Repo.transactions.put(row);
    await Repo.transactions.delete(id);
    expect(await Repo.transactions.get(id)).toBeUndefined();

    const cold = new RecoveryJournal(key, storage);
    let retained = await cold.read();
    if (!retained) throw new Error('Missing cold journal');
    markStorageUnavailable('continuity', { backend: 'wallet', operation: 'validate' });
    await withStorageRecoveryAccess(getStorageHealth().epoch, Date.now() + 5000, async capability => {
      await restoreWalletRecoveryRows(retained!, capability);
      const restored = await Repo.transactions.get(id);
      expect(restored).toMatchObject({
        status: ITransactionStatus.Unconfirmed,
        mayHaveSubmitted: true,
        restoredFromJournal: true,
        extraInputs: { provider: 'epoch', intentNonce: '22', evmTxHash: 'new-hash' },
        submitEvidence: row.submitEvidence
      });
      expect(Array.from(restored!.requestBytes!)).toEqual([1, 2, 3]);
      let retainCalls = 0;
      const reconcile = reconcileRecoveryTransactions({
        snapshot: retained!,
        database: Repo.db,
        deadline: Date.now() + 5000,
        assertCurrent: () => {},
        node: {
          blockCommitment: async () => 'header',
          account: async () =>
            outcome === 'indeterminate'
              ? { ok: false, pruned: false, timedOut: false }
              : { ok: true, state: { blockNum: 20, commitment: 'new', nonce: '2' } },
          noteInclusions: async () => new Map(),
          nullifierHeight: async () => undefined
        },
        retain: async entries => {
          retainCalls++;
          expect((await Repo.transactions.get(id))?.status).toBe(ITransactionStatus.Unconfirmed);
          if (outcome === 'retention failure') throw new Error('retention refused');
          retained = await cold.replaceEntries(retained!, entries, () => {});
        }
      });
      if (outcome === 'retention failure') await expect(reconcile).rejects.toThrow('retention refused');
      else await expect(reconcile).resolves.toBe(outcome === 'landed' ? 1 : 0);
      expect(retainCalls).toBe(outcome === 'indeterminate' ? 0 : 1);
      expect((await Repo.transactions.get(id))?.status).toBe(
        outcome === 'landed' ? ITransactionStatus.Completed : ITransactionStatus.Unconfirmed
      );
      const readback = await cold.read();
      const saved = readback?.entries.find(entry => entry.kind === 'transaction');
      expect(saved?.kind === 'transaction' && saved.resolved?.outcome).toBe(
        outcome === 'landed' ? 'landed' : undefined
      );
    });
  }
);
