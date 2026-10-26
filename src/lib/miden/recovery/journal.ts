import * as Passworder from '../passworder';
import { withRecoveryStorageLock } from './lock';
import { fromSerializable, toSerializable } from './serialization';
import type { RecoveryJournalData, RecoveryJournalSnapshot } from './types';
import { validateJournal } from './validation';
import { MAX_WINDOW_SECONDS } from '../spending-limits/window';
import { type StorageRecoveryCapability, StorageUnavailableError } from '../storage-health';

export interface RecoveryStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export const RECOVERY_JOURNAL_KEYS = ['miden_recovery_v1_0', 'miden_recovery_v1_1', 'miden_recovery_v1_active'];
export const JOURNAL_MAX_BYTES = 2 * 1024 * 1024;
export const JOURNAL_MAX_ENTRIES = 256;
const SLOT_KEYS = ['miden_recovery_v1_0', 'miden_recovery_v1_1'];
const POINTER_KEY = 'miden_recovery_v1_active';
const CIPHER_MAX_CHARS = Math.ceil((JOURNAL_MAX_BYTES + 16) / 3) * 4;

function payload(value: unknown): Passworder.EncryptedPayload {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid recovery ciphertext');
  const dt: unknown = Reflect.get(value, 'dt');
  const iv: unknown = Reflect.get(value, 'iv');
  if (typeof dt !== 'string' || dt.length > CIPHER_MAX_CHARS || typeof iv !== 'string' || iv.length !== 24)
    throw new Error('Invalid recovery ciphertext');
  return { dt, iv };
}
function serialize(data: unknown): string {
  const text = JSON.stringify(toSerializable(data));
  if (new TextEncoder().encode(text).length > JOURNAL_MAX_BYTES) throw new Error('Recovery journal capacity exceeded');
  return text;
}

export class RecoveryJournal {
  constructor(
    private key: CryptoKey,
    private storage: RecoveryStorage,
    private assertCurrent: () => Promise<void> = async () => {},
    private onFailure: (error: unknown) => void = () => {}
  ) {}

  async read(): Promise<RecoveryJournalSnapshot | undefined> {
    try {
      return await withRecoveryStorageLock(async () => (await this.readCurrent()).snapshot);
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  async repair(
    _expected: RecoveryJournalSnapshot,
    _capability: StorageRecoveryCapability
  ): Promise<RecoveryJournalSnapshot> {
    throw new StorageUnavailableError();
  }

  private async decrypt(value: unknown): Promise<RecoveryJournalSnapshot> {
    const decoded: unknown = await Passworder.decryptJson(payload(value), this.key);
    serialize(decoded);
    return validateJournal(fromSerializable(decoded));
  }

  private async readCurrent(): Promise<{ snapshot?: RecoveryJournalSnapshot; slot: number; degraded?: boolean }> {
    const values = await this.storage.get(RECOVERY_JOURNAL_KEYS);
    const pointer = values[POINTER_KEY];
    if (pointer === undefined && SLOT_KEYS.every(key => values[key] === undefined)) return { slot: 1 };
    let slot = -1;
    let sequence = -1;
    if (typeof pointer === 'object' && pointer !== null) {
      const index: unknown = Reflect.get(pointer, 'slot');
      const revision: unknown = Reflect.get(pointer, 'sequence');
      if ((index === 0 || index === 1) && typeof revision === 'number' && Number.isSafeInteger(revision)) {
        slot = index;
        sequence = revision;
      }
    }
    if (slot >= 0) {
      try {
        const snapshot = await this.decrypt(values[SLOT_KEYS[slot]!]);
        if (snapshot.sequence !== sequence) throw new Error('Recovery journal pointer mismatch');
        return { snapshot, slot };
      } catch (error) {
        this.onFailure(error);
      }
    }
    // A damaged pointer cannot choose between the slots. Keep the newest authenticated copy for recovery only.
    const candidates: { snapshot: RecoveryJournalSnapshot; slot: number; degraded: true }[] = [];
    for (let index = 0; index < SLOT_KEYS.length; index++) {
      if (index === slot || values[SLOT_KEYS[index]!] === undefined) continue;
      try {
        const snapshot = await this.decrypt(values[SLOT_KEYS[index]!]);
        if (sequence >= 0 && snapshot.sequence >= sequence) continue;
        candidates.push({ snapshot, slot: index, degraded: true });
      } catch {
        /* Try the other independent slot. */
      }
    }
    if (candidates.length > 0) {
      this.onFailure(new Error('Recovery journal active generation unavailable'));
      return candidates.sort((left, right) => right.snapshot.sequence - left.snapshot.sequence)[0]!;
    }
    throw new Error('Recovery journal unavailable');
  }

  async update(
    change: (current: RecoveryJournalSnapshot | undefined) => RecoveryJournalData
  ): Promise<RecoveryJournalSnapshot> {
    try {
      return await withRecoveryStorageLock(async () => {
        await this.assertCurrent();
        const { snapshot: previous, slot, degraded } = await this.readCurrent();
        if (degraded) throw new Error('Recovery journal requires repair');
        await this.assertCurrent();
        const proposed = change(previous);
        if (previous && JSON.stringify(previous.scope) !== JSON.stringify(proposed.scope))
          throw new Error('Recovery scope changed');
        if (
          previous &&
          previous.accounts.some(
            old =>
              !proposed.accounts.some(
                account =>
                  account.accountId === old.accountId &&
                  BigInt(account.nonce) >= BigInt(old.nonce) &&
                  (account.nonce !== old.nonce || account.commitment === old.commitment)
              )
          )
        )
          throw new Error('Recovery account floor decreased');
        const cutoff = Math.floor(Date.now() / 1000) - MAX_WINDOW_SECONDS;
        const retainedEntries = previous?.entries.filter(
          entry => entry.kind !== 'debit' || entry.initiatedAt >= cutoff
        );
        const entries = new Map(retainedEntries?.map(entry => [`${entry.kind}:${entry.id}`, entry]));
        for (const entry of proposed.entries) {
          if (entry.kind === 'debit' && entry.initiatedAt < cutoff) continue;
          const id = `${entry.kind}:${entry.id}`;
          const retained = entries.get(id);
          // A details fallback has default hints; it must not replace an imported file with its real tag and hint.
          if (
            entry.kind === 'note' &&
            entry.format === 'details' &&
            retained?.kind === 'note' &&
            retained.format !== 'details'
          )
            continue;
          entries.set(id, entry);
        }
        const next = validateJournal({
          ...proposed,
          entries: [...entries.values()],
          version: 1,
          sequence: (previous?.sequence ?? 0) + 1
        });
        const plaintext = serialize(next);
        if (previous && serialize({ ...next, sequence: previous.sequence }) === serialize(previous)) return previous;
        const encrypted = await Passworder.encryptJson(JSON.parse(plaintext), this.key);
        await this.assertCurrent();
        const nextSlot = 1 - slot;
        const key = SLOT_KEYS[nextSlot]!;
        await this.storage.set({ [key]: encrypted });
        await this.assertCurrent();
        const readback = await this.storage.get([key]);
        const verified = await this.decrypt(readback[key]);
        if (serialize(verified) !== plaintext) throw new Error('Recovery journal readback mismatch');
        await this.assertCurrent();
        await this.storage.set({ [POINTER_KEY]: { slot: nextSlot, sequence: next.sequence } });
        await this.assertCurrent();
        return verified;
      });
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }
}
