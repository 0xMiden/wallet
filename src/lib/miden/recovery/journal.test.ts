import { importVaultKey } from '../passworder';
import { RecoveryJournal, RECOVERY_JOURNAL_KEYS, JOURNAL_MAX_ENTRIES, type RecoveryStorage } from './journal';
import { receiptSnapshot } from './testing/provider-receipts';
import type { RecoveryJournalData } from './types';
import { validateJournal } from './validation';
import { getStorageHealth, withStorageRecoveryAccess } from '../storage-health';

class DisposableStorage implements RecoveryStorage {
  values: Record<string, unknown> = {};
  writes = 0;
  refuseWrite = false;
  corruptReadback = false;
  dropPointerWrite = false;
  async get(keys: string[]): Promise<Record<string, unknown>> {
    return Object.fromEntries(keys.map(key => [key, this.values[key]]));
  }
  async set(items: Record<string, unknown>): Promise<void> {
    if (this.refuseWrite) throw new Error('storage refused');
    this.writes++;
    for (const [key, value] of Object.entries(items)) {
      if (this.dropPointerWrite && key === RECOVERY_JOURNAL_KEYS[2]) continue;
      this.values[key] = this.corruptReadback ? 'corrupt' : value;
    }
  }
}

const data = (): RecoveryJournalData => ({
  scope: { network: 'testnet:node', walletGeneration: 'wallet-1', sdkGeneration: 'sdk-1' },
  accounts: [{ accountId: 'account-1', nonce: '3', commitment: 'commitment-3' }],
  entries: [
    { kind: 'note', id: 'note-1', accountId: 'account-1', noteFile: new Uint8Array([1, 2, 255]), provenance: 'input' }
  ]
});

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

let storage: DisposableStorage;
let journal: RecoveryJournal;
let key: CryptoKey;
beforeEach(async () => {
  key = await importVaultKey(new Uint8Array(32).fill(3));
  storage = new DisposableStorage();
  journal = new RecoveryJournal(key, storage);
});

it('encrypts note contents and verifies a round trip without copying signer material', async () => {
  const snapshot = await journal.update(data);
  expect(snapshot.sequence).toBe(1);
  expect(await new RecoveryJournal(key, storage).read()).toEqual(snapshot);
  expect(JSON.stringify(storage.values)).not.toContain('note-1');
  expect(JSON.stringify(storage.values)).not.toContain('account-1');
});

it('Task4C3D a fresh journal reader restores encrypted primary and quarantined candidate bytes', async () => {
  const candidate = {
    id: 'retained-candidate',
    accountId: 'account-1',
    provenance: 'input',
    noteFile: new Uint8Array([19, 48, 31, 247]),
    format: 'details'
  } satisfies import('./types').RecoveryNoteCandidate;
  const snapshot = await journal.update(() => ({
    ...data(),
    entries: [
      {
        kind: 'note',
        id: 'note-1',
        provenance: 'input',
        noteFile: new Uint8Array([1, 2, 255]),
        candidates: [candidate]
      }
    ]
  }));
  expect(await new RecoveryJournal(key, storage).read()).toEqual(snapshot);
  expect(snapshot.entries[0]).toMatchObject({ noteFile: new Uint8Array([1, 2, 255]), candidates: [candidate] });
  expect(JSON.stringify(storage.values)).not.toContain('retained-candidate');
});

it('Task4C1 retirement readback failure preserves the last good private body and pending evidence', async () => {
  const first = await journal.update(data);
  storage.corruptReadback = true;
  await expect(journal.replaceEntries(first, [], () => {})).rejects.toThrow();
  storage.corruptReadback = false;
  expect(await journal.read()).toEqual(first);
});

it('Task4C1 explicit retirement commits the new generation while retaining its future debit and grant', async () => {
  const initial = data();
  initial.entries.push({
    kind: 'debit',
    id: 'charged',
    accountId: 'account-1',
    initiatedAt: Math.floor(Date.now() / 1000) + 100,
    spentUsd: 7n,
    authorizationId: 'used'
  });
  const first = await journal.update(() => initial);
  await expect(journal.replaceEntries(first, [first.entries[1]!], () => {})).resolves.toMatchObject({ sequence: 2 });
  expect((await journal.read())?.entries).toEqual([initial.entries[1]]);
  await expect(journal.replaceEntries(first, [], () => {})).rejects.toThrow();
});

it('deduplicates an unchanged snapshot without another encryption or storage write', async () => {
  const first = await journal.update(data);
  const writes = storage.writes;
  expect(await journal.update(data)).toEqual(first);
  expect(storage.writes).toBe(writes);
});

it('retains the verified generation when the alternate write fails', async () => {
  const first = await journal.update(data);
  storage.refuseWrite = true;
  await expect(
    journal.update(() => ({
      ...data(),
      accounts: [{ accountId: 'account-1', nonce: '4', commitment: 'commitment-4' }]
    }))
  ).rejects.toThrow();
  storage.refuseWrite = false;
  expect(await journal.read()).toEqual(first);
});

it('does not promote a generation that fails encrypted readback validation', async () => {
  const first = await journal.update(data);
  storage.corruptReadback = true;
  await expect(
    journal.update(() => ({
      ...data(),
      accounts: [{ accountId: 'account-1', nonce: '4', commitment: 'commitment-4' }]
    }))
  ).rejects.toThrow();
  storage.corruptReadback = false;
  expect(await journal.read()).toEqual(first);
});

it('does not report a new generation when its active pointer write is lost', async () => {
  const first = await journal.update(data);
  storage.dropPointerWrite = true;

  await expect(
    journal.update(() => ({
      ...data(),
      accounts: [{ accountId: 'account-1', nonce: '4', commitment: 'commitment-4' }]
    }))
  ).rejects.toThrow('Recovery journal pointer readback mismatch');

  storage.dropPointerWrite = false;
  expect(await journal.read()).toEqual(first);
});

it('reads the last verified good slot after active ciphertext corruption', async () => {
  const first = await journal.update(data);
  await journal.update(() => ({
    ...data(),
    accounts: [{ accountId: 'account-1', nonce: '4', commitment: 'commitment-4' }]
  }));
  storage.values[RECOVERY_JOURNAL_KEYS[1]!] = 'broken';
  expect(await journal.read()).toEqual(first);
});

it('repairs a missing pointer only to the exact independently verified generation', async () => {
  const retained = await journal.update(data);
  const ciphertext = storage.values[RECOVERY_JOURNAL_KEYS[0]!];
  delete storage.values[RECOVERY_JOURNAL_KEYS[2]!];
  await withStorageRecoveryAccess(getStorageHealth().epoch, Date.now() + 5000, async capability => {
    await expect(journal.repair(retained, capability)).resolves.toEqual(retained);
  });
  expect(storage.values[RECOVERY_JOURNAL_KEYS[0]!]).toBe(ciphertext);
  expect(await journal.update(data)).toEqual(retained);
});

it('refuses journal repair from a surviving slot older than the independent continuity floor', async () => {
  const first = await journal.update(data);
  const latest = await journal.update(() => ({
    ...data(),
    accounts: [{ accountId: 'account-1', nonce: '4', commitment: 'commitment-4' }]
  }));
  storage.values[RECOVERY_JOURNAL_KEYS[1]!] = 'broken';
  const writes = storage.writes;
  await expect(
    withStorageRecoveryAccess(getStorageHealth().epoch, Date.now() + 5000, capability =>
      journal.repair(latest, capability)
    )
  ).rejects.toThrow();
  expect(storage.writes).toBe(writes);
  expect(await journal.read()).toEqual(first);
});

it('does not accept a repair whose pointer readback was corrupted', async () => {
  const retained = await journal.update(data);
  delete storage.values[RECOVERY_JOURNAL_KEYS[2]!];
  storage.corruptReadback = true;
  await expect(
    withStorageRecoveryAccess(getStorageHealth().epoch, Date.now() + 5000, capability =>
      journal.repair(retained, capability)
    )
  ).rejects.toThrow();
  storage.corruptReadback = false;
  expect(await journal.read()).toEqual(retained);
});

it('refuses to initialize over unreadable retained ciphertext', async () => {
  storage.values[RECOVERY_JOURNAL_KEYS[0]!] = 'broken';
  await expect(journal.update(data)).rejects.toThrow();
  expect(storage.writes).toBe(0);
});

it('fails closed at the entry bound while retaining all previous notes', async () => {
  const first = await journal.update(data);
  await expect(
    journal.update(() => ({
      ...data(),
      entries: Array.from({ length: JOURNAL_MAX_ENTRIES + 1 }, (_, i) => ({
        kind: 'note',
        id: `note-${i}`,
        accountId: 'account-1',
        noteFile: new Uint8Array([1]),
        provenance: 'input'
      }))
    }))
  ).rejects.toThrow();
  expect(await journal.read()).toEqual(first);
});

it('fails closed at the plaintext bound without replacing a previous generation', async () => {
  const first = await journal.update(data);
  await expect(
    journal.update(() => ({
      ...data(),
      entries: [
        {
          kind: 'note',
          id: 'large',
          accountId: 'account-1',
          noteFile: new Uint8Array(2 * 1024 * 1024),
          provenance: 'input'
        }
      ]
    }))
  ).rejects.toThrow();
  expect(await journal.read()).toEqual(first);
});

it('refuses a late writer after its vault identity was reset', async () => {
  const first = await journal.update(data);
  const retired = new RecoveryJournal(key, storage, async () => {
    throw new Error('retired');
  });
  await expect(
    retired.update(() => ({
      ...data(),
      accounts: [{ accountId: 'account-1', nonce: '4', commitment: 'commitment-4' }]
    }))
  ).rejects.toThrow('retired');
  expect(await journal.read()).toEqual(first);
});

it('serializes writers from separate journal instances without losing retained notes', async () => {
  await journal.update(data);
  const sibling = new RecoveryJournal(key, storage);
  const second = {
    kind: 'note',
    id: 'second',
    accountId: 'account-1',
    noteFile: new Uint8Array([2]),
    provenance: 'input'
  };
  const third = { ...second, id: 'third' };
  await Promise.all([
    journal.update(() => ({ ...data(), entries: [{ ...second, kind: 'note', provenance: 'input' }] })),
    sibling.update(() => ({ ...data(), entries: [{ ...third, kind: 'note', provenance: 'input' }] }))
  ]);
  expect((await journal.read())?.entries.map(entry => entry.id)).toEqual(['note-1', 'second', 'third']);
});
it('keeps an imported note file when a later details fallback has default hints', async () => {
  const first = await journal.update(data);
  const next = await journal.update(() => ({
    ...data(),
    entries: [
      {
        kind: 'note',
        id: 'note-1',
        accountId: 'account-1',
        noteFile: new Uint8Array([0]),
        provenance: 'input',
        format: 'details'
      }
    ]
  }));
  expect(next).toEqual(first);
});
it('rejects fields outside the recovery schema before encrypting secret material', async () => {
  const first = await journal.update(data);
  const next = { ...data(), mnemonic: 'must never be retained' };
  await expect(journal.update(() => next)).rejects.toThrow('Invalid recovery journal');
  expect(await journal.read()).toEqual(first);
  expect(JSON.stringify(storage.values)).not.toContain('must never');
});

it('recovers the latest verified generation when only the active pointer is lost', async () => {
  await journal.update(data);
  const latest = await journal.update(() => ({
    ...data(),
    accounts: [{ accountId: 'account-1', nonce: '4', commitment: 'commitment-4' }]
  }));
  delete storage.values.miden_recovery_v1_active;
  expect(await journal.read()).toEqual(latest);
});

it('retires only expired debit entries while retaining future charges and private evidence', async () => {
  const now = Math.floor(Date.now() / 1000);
  await journal.update(() => ({
    ...data(),
    entries: [
      ...data().entries,
      { kind: 'debit', id: 'expired', accountId: 'account-1', initiatedAt: now - 86401, spentUsd: 3n },
      { kind: 'debit', id: 'future', accountId: 'account-1', initiatedAt: now + 86401, spentUsd: 5n }
    ]
  }));
  const next = await journal.update(data);
  expect(next.entries.map(entry => entry.id)).toEqual(['note-1', 'future']);
});

it('Task4C2 encrypted receipt roundtrip preserves expired provider evidence without Miden request bytes', async () => {
  await expect(journal.update(() => validateJournal(receiptSnapshot()))).resolves.toMatchObject({ sequence: 1 });
  const retained = await new RecoveryJournal(key, storage).read();
  expect(retained?.entries[0]).toEqual(receiptSnapshot().entries[0]);
  expect(JSON.stringify(storage.values)).not.toContain('receipt-correlation');
});

it('Task4C2 rejected receipt readback preserves the previous verified generation', async () => {
  const initial = receiptSnapshot();
  const first = await journal.update(() => ({
    ...initial,
    entries: data().entries.map(entry => ({ ...entry, accountId: initial.accounts[0]!.accountId }))
  }));
  const writes = storage.writes;
  storage.corruptReadback = true;
  await expect(journal.update(() => validateJournal(initial))).rejects.toThrow();
  storage.corruptReadback = false;
  expect(await journal.read()).toEqual(first);
  expect(storage.writes).toBe(writes + 1);
});

it('Task4C2 typed payout roundtrip preserves the original snapshot cursor and exact mint proof', async () => {
  const base = receiptSnapshot();
  const row = base.entries[0]!.row;
  row.type = 'bridged-send';
  row.extraInputs = {
    provider: 'usdcx',
    destinationAddress: '0x1111111111111111111111111111111111111111',
    destinationNetwork: 1,
    sourceFaucetId: row.faucetId,
    claimStatus: 'not-applicable',
    usdcxBurn: {
      noteId: 'burn-id',
      destinationDomain: 0,
      destinationUsdc: '0x2222222222222222222222222222222222222222',
      payoutFeeAllowance: '100000',
      phase: 'confirmed',
      confirmedAt: 100,
      attemptCount: 2,
      lastAttemptBlockNum: 50,
      destinationBalanceBefore: { balance: '400', blockNumber: '100' },
      destinationBalanceConfirmed: { balance: '600', blockNumber: '200' },
      payoutScannedBlock: '500',
      payout: { transactionHash: `0x${'3'.repeat(64)}`, blockNumber: '700', value: '980000' }
    }
  };
  const first = await journal.update(() => validateJournal(base));
  const restored = await new RecoveryJournal(key, storage).read();
  expect(restored?.entries[0]).toEqual(first.entries[0]);
  const entry = restored?.entries[0];
  expect(entry?.kind === 'receipt' && entry.row.extraInputs?.usdcxBurn).toEqual(row.extraInputs.usdcxBurn);
  expect(JSON.stringify(storage.values)).not.toContain('burn-id');
});
