import * as Passworder from '../passworder';
import { withRecoveryStorageLock } from './lock';
import { recoveryNoteMaterials, retainNoteCandidates } from './note-candidates';
import { resolveRecoveryDebit } from './retry-transition';
import { fromSerializable, toSerializable } from './serialization';
import type { RecoveryEntry, RecoveryJournalData, RecoveryJournalSnapshot } from './types';
import { validateJournal } from './validation';
import { MAX_WINDOW_SECONDS } from '../spending-limits/window';
import { type StorageRecoveryCapability, assertStorageRecoveryAllowed } from '../storage-health';

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
function serialize(data: unknown, capacityError?: Error): string {
  const text = JSON.stringify(toSerializable(data));
  if (new TextEncoder().encode(text).length > JOURNAL_MAX_BYTES)
    throw capacityError ?? new Error('Recovery journal capacity exceeded');
  return text;
}

const integrityFailures = new WeakSet<object>();

function integrityFailure(message: string): Error {
  const error = new Error(message);
  integrityFailures.add(error);
  return error;
}

export function isRecoveryJournalIntegrityFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && integrityFailures.has(error);
}

export class RecoveryJournal {
  constructor(
    private key: CryptoKey,
    private storage: RecoveryStorage,
    private assertCurrent: () => Promise<void> = async () => {},
    private onFailure: (error: unknown) => void = () => {}
  ) {}

  async replaceEntries(
    expected: RecoveryJournalSnapshot,
    entries: RecoveryEntry[],
    assertAllowed: () => void
  ): Promise<RecoveryJournalSnapshot> {
    try {
      return await withRecoveryStorageLock(async () => {
        const check = async () => {
          assertAllowed();
          await this.assertCurrent();
          assertAllowed();
        };
        await check();
        const current = await this.readCurrent();
        await check();
        if (
          current.degraded ||
          !current.snapshot ||
          serialize(current.snapshot) !== serialize(validateJournal(expected))
        )
          throw new Error('Recovery journal changed');
        const cutoff = Math.floor(Date.now() / 1000) - MAX_WINDOW_SECONDS;
        const protectedEntries = current.snapshot.entries.filter(
          entry =>
            entry.kind === 'policy' || (entry.kind === 'debit' && resolveRecoveryDebit(entry).initiatedAt >= cutoff)
        );
        for (const retained of protectedEntries) {
          if (!entries.some(entry => serialize(entry) === serialize(retained)))
            throw new Error('Recovery financial evidence required');
        }
        const next = validateJournal({ ...current.snapshot, entries, sequence: current.snapshot.sequence + 1 });
        const plaintext = serialize(next);
        if (serialize({ ...next, sequence: current.snapshot.sequence }) === serialize(current.snapshot))
          return current.snapshot;
        const encrypted = await Passworder.encryptJson(JSON.parse(plaintext), this.key);
        await check();
        const slot = 1 - current.slot;
        const key = SLOT_KEYS[slot]!;
        await this.storage.set({ [key]: encrypted });
        await check();
        const values = await this.storage.get([key]);
        await check();
        const verified = await this.decrypt(values[key]);
        await check();
        if (serialize(verified) !== plaintext) throw integrityFailure('Recovery journal readback mismatch');
        await this.storage.set({ [POINTER_KEY]: { slot, sequence: next.sequence } });
        await check();
        const readback = await this.readCurrent(false);
        await check();
        if (readback.degraded || !readback.snapshot || serialize(readback.snapshot) !== plaintext)
          throw integrityFailure('Recovery journal pointer readback mismatch');
        return verified;
      });
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  async read(): Promise<RecoveryJournalSnapshot | undefined> {
    try {
      return await withRecoveryStorageLock(async () => (await this.readCurrent()).snapshot);
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  async repair(
    expected: RecoveryJournalSnapshot,
    capability: StorageRecoveryCapability
  ): Promise<RecoveryJournalSnapshot> {
    return withRecoveryStorageLock(async () => {
      const check = async () => {
        assertStorageRecoveryAllowed(capability);
        await this.assertCurrent();
        assertStorageRecoveryAllowed(capability);
      };
      await check();
      const retained = await this.readCurrent(false);
      await check();
      if (!retained.snapshot || serialize(retained.snapshot) !== serialize(validateJournal(expected)))
        throw new Error('Recovery journal continuity floor mismatch');
      if (retained.degraded) {
        await this.storage.set({ [POINTER_KEY]: { slot: retained.slot, sequence: retained.snapshot.sequence } });
        await check();
      }
      const verified = await this.readCurrent(false);
      await check();
      if (verified.degraded || !verified.snapshot || serialize(verified.snapshot) !== serialize(expected))
        throw integrityFailure('Recovery journal repair readback mismatch');
      return verified.snapshot;
    });
  }

  private async decrypt(value: unknown): Promise<RecoveryJournalSnapshot> {
    const decoded: unknown = await Passworder.decryptJson(payload(value), this.key);
    serialize(decoded);
    return validateJournal(fromSerializable(decoded));
  }

  private async readCurrent(
    reportDamage = true
  ): Promise<{ snapshot?: RecoveryJournalSnapshot; slot: number; degraded?: boolean }> {
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
        if (reportDamage) this.onFailure(error);
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
      if (reportDamage) this.onFailure(new Error('Recovery journal active generation unavailable'));
      return candidates.sort((left, right) => right.snapshot.sequence - left.snapshot.sequence)[0]!;
    }
    throw new Error('Recovery journal unavailable');
  }

  async update(
    change: (current: RecoveryJournalSnapshot | undefined) => RecoveryJournalData,
    committedRetries: readonly string[] = [],
    recoveryFloor?: { minimumSequence: number; capability: StorageRecoveryCapability }
  ): Promise<RecoveryJournalSnapshot> {
    if (recoveryFloor) {
      assertStorageRecoveryAllowed(recoveryFloor.capability);
      if (!Number.isSafeInteger(recoveryFloor.minimumSequence) || recoveryFloor.minimumSequence < 1)
        throw new Error('Invalid recovery journal floor');
    }
    const assertCurrent = async () => {
      if (recoveryFloor) assertStorageRecoveryAllowed(recoveryFloor.capability);
      await this.assertCurrent();
      if (recoveryFloor) assertStorageRecoveryAllowed(recoveryFloor.capability);
    };
    const capacityError = new Error('Recovery journal capacity exceeded');
    try {
      return await withRecoveryStorageLock(async () => {
        await assertCurrent();
        const { snapshot: previous, slot, degraded } = await this.readCurrent();
        if (degraded) throw new Error('Recovery journal requires repair');
        await assertCurrent();
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
          entry => entry.kind !== 'debit' || resolveRecoveryDebit(entry).initiatedAt >= cutoff
        );
        const entries = new Map(retainedEntries?.map(entry => [`${entry.kind}:${entry.id}`, entry]));
        for (const entry of proposed.entries) {
          if (entry.kind === 'debit' && resolveRecoveryDebit(entry).initiatedAt < cutoff) continue;
          const id = `${entry.kind}:${entry.id}`;
          const retained = entries.get(id);
          if (
            retained?.kind === 'debit' &&
            retained.retry &&
            entry.kind === 'debit' &&
            !entry.retry &&
            !committedRetries.includes(entry.id)
          )
            continue;
          // A details fallback has default hints; it must not replace an imported file with its real tag and hint.
          if (
            entry.kind === 'note' &&
            entry.format === 'details' &&
            retained?.kind === 'note' &&
            retained.format !== 'details'
          )
            continue;
          entries.set(
            id,
            entry.kind === 'note' && retained?.kind === 'note' && (entry.candidates || retained.candidates)
              ? retainNoteCandidates(retained, entry)
              : entry
          );
        }
        const merged = [...entries.values()];
        if (
          merged.reduce(
            (count, entry) => count + (entry.kind === 'note' ? recoveryNoteMaterials(entry).length : 1),
            0
          ) > JOURNAL_MAX_ENTRIES
        )
          throw capacityError;
        const next = validateJournal({
          ...proposed,
          entries: merged,
          version: 1,
          sequence: Math.max((previous?.sequence ?? 0) + 1, recoveryFloor?.minimumSequence ?? 1)
        });
        const plaintext = serialize(next, capacityError);
        if (
          previous &&
          (!recoveryFloor || recoveryFloor.minimumSequence <= previous.sequence) &&
          serialize({ ...next, sequence: previous.sequence }) === serialize(previous)
        )
          return previous;
        const encrypted = await Passworder.encryptJson(JSON.parse(plaintext), this.key);
        await assertCurrent();
        const nextSlot = 1 - slot;
        const key = SLOT_KEYS[nextSlot]!;
        await this.storage.set({ [key]: encrypted });
        await assertCurrent();
        const readback = await this.storage.get([key]);
        const verified = await this.decrypt(readback[key]);
        if (serialize(verified) !== plaintext) throw integrityFailure('Recovery journal readback mismatch');
        await assertCurrent();
        await this.storage.set({ [POINTER_KEY]: { slot: nextSlot, sequence: next.sequence } });
        await assertCurrent();
        return verified;
      });
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }
}
