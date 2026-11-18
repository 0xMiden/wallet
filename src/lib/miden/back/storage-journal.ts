import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { getStorageProvider } from 'lib/platform/storage-adapter';

import { inStorageTurn } from '../front/storage';
import { decryptJson, encryptJson, type EncryptedPayload } from '../passworder';
import type { PersistedSpendingLimit } from '../spending-limits/types';
import { markWalletStorageUnavailable, WalletStorageUnavailableError } from '../storage-health';

const SLOTS = ['miden_recovery_v1_slot0', 'miden_recovery_v1_slot1'] as const;
const TURN = 'miden_recovery_v1';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_NOTES = 256;

export interface RecoveryAccount {
  id: string;
  state: string;
}

interface RecoveryData {
  accounts: RecoveryAccount[];
  notes: string[];
  transfers: Record<string, string>;
  limits: PersistedSpendingLimit[];
  walletStoreGeneration?: string;
}

interface Snapshot extends RecoveryData {
  version: 1;
  generation: number;
  network: string;
}

function validate(snapshot: Snapshot): Snapshot {
  if (
    snapshot?.version !== 1 ||
    !Number.isSafeInteger(snapshot.generation) ||
    snapshot.generation < 1 ||
    typeof snapshot.network !== 'string' ||
    !Array.isArray(snapshot.accounts) ||
    snapshot.accounts.some(account => typeof account?.id !== 'string' || typeof account?.state !== 'string') ||
    !Array.isArray(snapshot.notes) ||
    snapshot.notes.length > MAX_NOTES ||
    snapshot.notes.some(note => typeof note !== 'string') ||
    typeof snapshot.transfers !== 'object' ||
    snapshot.transfers === null ||
    Object.values(snapshot.transfers).some(row => typeof row !== 'string') ||
    !Array.isArray(snapshot.limits) ||
    (snapshot.walletStoreGeneration !== undefined && typeof snapshot.walletStoreGeneration !== 'string') ||
    new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > MAX_BYTES
  ) {
    throw new WalletStorageUnavailableError();
  }
  return snapshot;
}

export class StorageJournal {
  constructor(private readonly key: CryptoKey) {}

  private async current(): Promise<Snapshot | undefined> {
    const values = await getStorageProvider().get([...SLOTS]);
    const snapshots = await Promise.all(
      SLOTS.flatMap(slot => {
        const value: EncryptedPayload | undefined = values[slot];
        return value === undefined ? [] : [decryptJson(value, this.key).then(validate)];
      })
    );
    const snapshot = snapshots.sort((a, b) => b.generation - a.generation)[0];
    if (snapshot && snapshot.network !== getEffectiveNetworkName()) throw new WalletStorageUnavailableError();
    return snapshot;
  }

  async read(): Promise<RecoveryData | undefined> {
    return inStorageTurn(TURN, () => this.current());
  }

  async retain(change: (old: RecoveryData) => RecoveryData, assertCurrent: () => void): Promise<void> {
    try {
      await inStorageTurn(TURN, async () => {
        assertCurrent();
        const previous = await this.current();
        const network = getEffectiveNetworkName();
        const empty: RecoveryData = { accounts: [], notes: [], transfers: {}, limits: [] };
        const snapshot = validate({
          ...change(previous ?? empty),
          version: 1,
          network,
          generation: (previous?.generation ?? 0) + 1
        });
        if (
          previous &&
          JSON.stringify(previous.accounts) === JSON.stringify(snapshot.accounts) &&
          JSON.stringify(previous.notes) === JSON.stringify(snapshot.notes) &&
          JSON.stringify(previous.transfers) === JSON.stringify(snapshot.transfers) &&
          JSON.stringify(previous.limits) === JSON.stringify(snapshot.limits) &&
          previous.walletStoreGeneration === snapshot.walletStoreGeneration
        )
          return;

        const slot = SLOTS[snapshot.generation % SLOTS.length]!;
        const value = await encryptJson(snapshot, this.key);
        const storage = getStorageProvider();
        assertCurrent();
        if (getEffectiveNetworkName() !== network) throw new WalletStorageUnavailableError();
        await storage.set({ [slot]: value });
        const written = (await storage.get([slot]))[slot];
        if (written?.dt !== value.dt || written?.iv !== value.iv) throw new WalletStorageUnavailableError();
        assertCurrent();
      });
    } catch (error) {
      await markWalletStorageUnavailable();
      throw error;
    }
  }
}
