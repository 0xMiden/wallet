import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { getStorageProvider } from 'lib/platform/storage-adapter';

import { inStorageTurn } from '../front/storage';
import { decryptJson, encryptJson, type EncryptedPayload } from '../passworder';
import type { PersistedSpendingLimit } from '../spending-limits/types';
import { markWalletStorageUnavailable, WalletStorageUnavailableError } from '../storage-health';

const TURN = 'miden_recovery_v1';
const MAX_BYTES = 2 * 1024 * 1024;

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

  private async current(network: string, head: string, slots: string[]): Promise<Snapshot | undefined> {
    const values = await getStorageProvider().get([head, ...slots]);
    const generation = values[head];
    if (generation === 0 || (generation === undefined && slots.every(slot => values[slot] === undefined))) return;
    if (!Number.isSafeInteger(generation) || generation < 1) throw new WalletStorageUnavailableError();
    const value: EncryptedPayload | undefined = values[slots[generation % slots.length]!];
    if (!value) throw new WalletStorageUnavailableError();
    const snapshot = validate(await decryptJson(value, this.key));
    if (snapshot.network !== network || snapshot.generation !== generation) throw new WalletStorageUnavailableError();
    return snapshot;
  }

  async read(): Promise<RecoveryData | undefined> {
    const network = getEffectiveNetworkName();
    try {
      return await inStorageTurn(TURN, () => this.current(network, headFor(network), slotsFor(network)));
    } catch (error) {
      await markWalletStorageUnavailable();
      throw error;
    }
  }

  async retain(
    change: (old: RecoveryData) => RecoveryData | Promise<RecoveryData>,
    assertCurrent: () => void
  ): Promise<void> {
    let sessionChanged = false;
    try {
      await inStorageTurn(TURN, async () => {
        const network = getEffectiveNetworkName();
        const assertSession = () => {
          try {
            assertCurrent();
            if (getEffectiveNetworkName() !== network) throw new WalletStorageUnavailableError();
          } catch (error) {
            sessionChanged = true;
            throw error;
          }
        };
        assertSession();
        const head = headFor(network);
        const slots = slotsFor(network);
        const previous = await this.current(network, head, slots);
        const empty: RecoveryData = { accounts: [], notes: [], transfers: {}, limits: [] };
        const data = await change(previous ?? empty);
        assertSession();
        const snapshot = validate({
          ...data,
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

        const slot = slots[snapshot.generation % slots.length]!;
        const value = await encryptJson(snapshot, this.key);
        const storage = getStorageProvider();
        assertSession();
        if (!previous) await storage.set({ [head]: 0 });
        await storage.set({ [slot]: value });
        const written = (await storage.get([slot]))[slot];
        if (written?.dt !== value.dt || written?.iv !== value.iv) throw new WalletStorageUnavailableError();
        assertSession();
        await storage.set({ [head]: snapshot.generation });
        if ((await storage.get([head]))[head] !== snapshot.generation) throw new WalletStorageUnavailableError();
        assertSession();
      });
    } catch (error) {
      if (!sessionChanged) await markWalletStorageUnavailable();
      throw error;
    }
  }
}

function slotsFor(network: string) {
  return [`${TURN}_${network}_slot0`, `${TURN}_${network}_slot1`];
}

function headFor(network: string) {
  return `${TURN}_${network}_head`;
}
