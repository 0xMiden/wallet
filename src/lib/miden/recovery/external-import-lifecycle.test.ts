import { generateVaultKey, importVaultKey } from '../passworder';
import { getStorageHealth, withStorageRecoveryAccess, type StorageRecoveryCapability } from '../storage-health';
import { RecoveryJournal, type RecoveryStorage } from './journal';
import type { RecoveryJournalData } from './types';

const data = (): RecoveryJournalData => ({
  scope: { network: 'testnet:node', walletGeneration: 'wallet-import', sdkGeneration: 'sdk-import' },
  accounts: [{ accountId: 'account-import', nonce: '4', commitment: 'state-4' }],
  entries: [
    {
      kind: 'note',
      id: 'private-import',
      accountId: 'account-import',
      noteFile: new Uint8Array([1, 2, 3]),
      provenance: 'input'
    }
  ]
});

class MemoryStorage implements RecoveryStorage {
  values: Record<string, unknown> = {};
  writeCount = 0;
  beforeWrite?: () => Promise<void>;
  async get(keys: string[]): Promise<Record<string, unknown>> {
    return Object.fromEntries(keys.map(key => [key, this.values[key]]));
  }
  async set(values: Record<string, unknown>): Promise<void> {
    this.writeCount++;
    Object.assign(this.values, values);
    await this.beforeWrite?.();
  }
}

async function advance(journal: RecoveryJournal, capability: StorageRecoveryCapability, minimumSequence: number) {
  const result: unknown = Reflect.apply(journal.update, journal, [data, [], { minimumSequence, capability }]);
  return result;
}

beforeEach(() => {
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (_name: string, operation: () => Promise<unknown>) => operation()
    }
  });
});

describe('Task5 recovery import floor permissions', () => {
  it.each([false, true])('preserves a stronger minimum sequence with existing journal %s', async existing => {
    const storage = new MemoryStorage();
    const journal = new RecoveryJournal(await importVaultKey(generateVaultKey()), storage);
    if (existing) await journal.update(data);
    await withStorageRecoveryAccess(getStorageHealth().epoch, Date.now() + 5000, async capability => {
      await expect(advance(journal, capability, 20)).resolves.toMatchObject({ sequence: 20 });
    });
    await expect(journal.read()).resolves.toMatchObject({ sequence: 20 });
  });

  it('a structurally forged capability grants no floor publication', async () => {
    const storage = new MemoryStorage();
    const journal = new RecoveryJournal(await importVaultKey(generateVaultKey()), storage);
    const capability = { epoch: getStorageHealth().epoch, expiresAt: Date.now() + 5000 };
    await expect(advance(journal, capability, 20)).rejects.toThrow('StorageUnavailableError');
    expect(storage.writeCount).toBe(0);
  });

  it('an accepted slot write that settles after capability expiry cannot publish the active pointer', async () => {
    const storage = new MemoryStorage();
    const journal = new RecoveryJournal(await importVaultKey(generateVaultKey()), storage);
    let start!: () => void;
    let finish!: () => void;
    const started = new Promise<void>(resolve => {
      start = resolve;
    });
    const released = new Promise<void>(resolve => {
      finish = resolve;
    });
    storage.beforeWrite = async () => {
      start();
      await released;
    };
    const now = Date.now();
    const pending = withStorageRecoveryAccess(getStorageHealth().epoch, now + 1000, capability =>
      advance(journal, capability, 20)
    );
    const observed = pending.then(
      () => 'resolved',
      () => 'refused'
    );
    let clock: jest.SpyInstance | undefined;
    try {
      await expect(Promise.race([started.then(() => 'started'), observed])).resolves.toBe('started');
      clock = jest.spyOn(Date, 'now').mockReturnValue(now + 1001);
      finish();
      await expect(pending).rejects.toThrow('StorageUnavailableError');
      expect(storage.values.miden_recovery_v1_active).toBeUndefined();
    } finally {
      finish();
      await observed;
      clock?.mockRestore();
    }
  });
});
