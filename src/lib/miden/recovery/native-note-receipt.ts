import { NoteFile, type NoteAcquisitionCandidate } from '@miden-sdk/miden-sdk/lazy';

import { StorageContinuityError } from './continuity';
import { JOURNAL_MAX_BYTES } from './journal';
import { readSdkGeneration, type RecoverySdkReader } from './sdk-snapshot';
import { toSerializable } from './serialization';
import type { RecoveryJournalSnapshot, RecoveryNoteEntry, RecoveryScope } from './types';
import { isRecoveryScope } from './validation';
import { assertWasmHoldCurrent, getCurrentWasmLockHold, type WasmLockHold } from '../sdk/miden-client';
import { normalizedCommitment, noteDetailsCommitment } from '../sdk/note-details-commitment';
import { assertStorageRecoveryAllowed, type StorageRecoveryCapability } from '../storage-health';

const receiptBrand = Symbol('retained-note-receipt');
export interface RetainedNoteReceipt {
  readonly [receiptBrand]: true;
}
interface Authority {
  capability: StorageRecoveryCapability;
  hold: WasmLockHold;
  accountId: string;
  fingerprint: string;
  scope: RecoveryJournalSnapshot['scope'];
  sequence: number;
  assertCurrent: () => void;
  acknowledge?: (note: RecoveryNoteEntry) => Promise<void>;
}
interface PreparedNote {
  bytes: Uint8Array;
  variant: 'expectedNote' | 'committed';
  detailsCommitment: string;
  noteId?: string;
  nullifier?: string;
  tag?: number;
  afterBlockNum?: number;
  sender?: string;
  noteType?: number;
}
interface PreparedReceipt extends PreparedNote {
  hold: WasmLockHold;
  assertCurrent: () => void;
  acknowledge?: (note: RecoveryNoteEntry) => Promise<void>;
  used: boolean;
}
const authorities = new WeakMap<RetainedNoteReceipt, Authority>();
const preparedByClient = new WeakMap<object, PreparedReceipt>();

function authorityFor(receipt: RetainedNoteReceipt): Authority {
  const authority = authorities.get(receipt);
  if (!authority) throw new StorageContinuityError();
  assertStorageRecoveryAllowed(authority.capability);
  assertWasmHoldCurrent(authority.hold, 'retained note receipt');
  authority.assertCurrent();
  return authority;
}

export async function withRetainedNoteReceipt<T>(
  snapshot: RecoveryJournalSnapshot,
  note: RecoveryNoteEntry,
  accountId: string,
  capability: StorageRecoveryCapability,
  assertCurrent: () => void,
  operation: (receipt: RetainedNoteReceipt) => Promise<T>
): Promise<T> {
  assertStorageRecoveryAllowed(capability);
  assertCurrent();
  const hold = getCurrentWasmLockHold();
  if (
    !hold ||
    !snapshot.entries.includes(note) ||
    note.provenance !== 'input' ||
    !snapshot.accounts.some(account => account.accountId === accountId) ||
    (note.accountId !== undefined && note.accountId !== accountId)
  )
    throw new StorageContinuityError();
  const receipt: RetainedNoteReceipt = { [receiptBrand]: true };
  const scope = { ...snapshot.scope };
  const sequence = snapshot.sequence;
  authorities.set(receipt, {
    capability,
    hold,
    accountId,
    fingerprint: JSON.stringify(toSerializable(note)),
    scope,
    sequence,
    assertCurrent: () => {
      assertCurrent();
      if (snapshot.sequence !== sequence || JSON.stringify(snapshot.scope) !== JSON.stringify(scope))
        throw new StorageContinuityError();
    }
  });
  try {
    const result = await operation(receipt);
    authorityFor(receipt);
    return result;
  } finally {
    authorities.delete(receipt);
  }
}

function prepareNote(file: NoteFile, note: RecoveryNoteEntry): PreparedNote {
  const full = file.note();
  const details = file.noteDetails();
  const identifier = file.noteId();
  const metadata = full?.metadata();
  const sender = metadata?.sender();
  const tag = metadata?.tag() ?? file.noteTag();
  try {
    const body = full ?? details;
    if (!body) throw new StorageContinuityError();
    const detailsCommitment = noteDetailsCommitment(body);
    const noteId = identifier ? normalizedCommitment(identifier.toString()) : undefined;
    const bytes = file.serialize().slice();
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength > JOURNAL_MAX_BYTES ||
      normalizedCommitment(note.id) !== (noteId ?? detailsCommitment) ||
      (note.detailsId !== undefined && note.detailsId !== detailsCommitment)
    )
      throw new StorageContinuityError();
    return {
      bytes,
      variant: full ? 'committed' : 'expectedNote',
      detailsCommitment,
      noteId,
      nullifier: file.nullifier(),
      tag: tag?.asU32(),
      afterBlockNum: file.afterBlockNum(),
      sender: sender?.toString(),
      noteType: metadata?.noteType()
    };
  } finally {
    tag?.free();
    sender?.free();
    metadata?.free();
    identifier?.free();
    details?.free();
    full?.free();
  }
}

function preparedEntry(prepared: PreparedNote): RecoveryNoteEntry {
  return {
    kind: 'note',
    id: prepared.noteId ?? prepared.detailsCommitment,
    detailsId: prepared.detailsCommitment,
    noteFile: prepared.bytes.slice(),
    provenance: 'input',
    format: prepared.variant === 'committed' ? 'full' : 'details'
  };
}

function assertReceiptNote(
  authority: Authority,
  capability: StorageRecoveryCapability,
  note: RecoveryNoteEntry,
  accountId: string
): void {
  if (
    authority.capability !== capability ||
    authority.accountId !== accountId ||
    authority.fingerprint !== JSON.stringify(toSerializable(note))
  )
    throw new StorageContinuityError();
}

export interface RetainedNoteContext {
  scope: RecoveryScope;
  sequence: number;
  accountId: string;
  primaryId: string;
  detailsId?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function decodeRetainedNoteContext(value: unknown): RetainedNoteContext {
  if (!record(value)) throw new StorageContinuityError();
  const { scope, sequence, accountId, primaryId, detailsId } = value;
  if (
    Object.keys(value).some(key => !['scope', 'sequence', 'accountId', 'primaryId', 'detailsId'].includes(key)) ||
    !isRecoveryScope(scope) ||
    typeof sequence !== 'number' ||
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    typeof accountId !== 'string' ||
    accountId.length === 0 ||
    accountId.length > 2048 ||
    typeof primaryId !== 'string' ||
    !/^[0-9a-f]{64}$/.test(primaryId) ||
    (detailsId !== undefined && (typeof detailsId !== 'string' || !/^[0-9a-f]{64}$/.test(detailsId)))
  )
    throw new StorageContinuityError();
  return { scope: { ...scope }, sequence, accountId, primaryId, detailsId };
}

export function prepareOffscreenRetainedNoteReceipt(
  receipt: RetainedNoteReceipt,
  capability: StorageRecoveryCapability,
  note: RecoveryNoteEntry,
  accountId: string
) {
  const authority = authorityFor(receipt);
  assertReceiptNote(authority, capability, note, accountId);
  const file = NoteFile.deserialize(note.noteFile);
  let prepared: PreparedNote;
  try {
    prepared = prepareNote(file, note);
  } finally {
    file.free();
  }
  const context = decodeRetainedNoteContext({
    scope: authority.scope,
    sequence: authority.sequence,
    accountId,
    primaryId: normalizedCommitment(note.id),
    detailsId: note.detailsId
  });
  let used = false;
  const check = () => {
    authorityFor(receipt);
  };
  check();
  return {
    context,
    assertCurrent: check,
    acknowledge: (notes: RecoveryNoteEntry[]) => {
      check();
      const supplied = notes[0];
      if (
        used ||
        notes.length !== 1 ||
        !supplied ||
        supplied.provenance !== 'input' ||
        normalizedCommitment(supplied.id) !== (prepared.noteId ?? prepared.detailsCommitment) ||
        supplied.detailsId !== prepared.detailsCommitment ||
        supplied.noteFile.byteLength !== prepared.bytes.byteLength ||
        !supplied.noteFile.every((byte, index) => byte === prepared.bytes[index])
      )
        throw new StorageContinuityError();
      used = true;
      check();
    }
  };
}

export async function withRemoteRetainedNoteReceipt<T>(
  value: unknown,
  note: RecoveryNoteEntry,
  accountId: string,
  capability: StorageRecoveryCapability,
  network: string,
  assertCurrent: () => void,
  acknowledge: (note: RecoveryNoteEntry) => Promise<void>,
  operation: (receipt: RetainedNoteReceipt) => Promise<T>
): Promise<T> {
  const context = decodeRetainedNoteContext(value);
  assertStorageRecoveryAllowed(capability);
  assertCurrent();
  const hold = getCurrentWasmLockHold();
  if (
    !hold ||
    context.scope.network !== network ||
    context.accountId !== accountId ||
    context.primaryId !== normalizedCommitment(note.id) ||
    context.detailsId !== note.detailsId ||
    note.provenance !== 'input' ||
    (note.accountId !== undefined && note.accountId !== accountId)
  )
    throw new StorageContinuityError();
  const receipt: RetainedNoteReceipt = { [receiptBrand]: true };
  authorities.set(receipt, {
    capability,
    hold,
    accountId,
    fingerprint: JSON.stringify(toSerializable(note)),
    scope: context.scope,
    sequence: context.sequence,
    assertCurrent,
    acknowledge
  });
  try {
    const result = await operation(receipt);
    authorityFor(receipt);
    return result;
  } finally {
    authorities.delete(receipt);
  }
}

export async function withPreparedNativeNoteReceipt<T>(
  client: RecoverySdkReader,
  receipt: RetainedNoteReceipt,
  capability: StorageRecoveryCapability,
  note: RecoveryNoteEntry,
  accountId: string,
  file: NoteFile,
  assertCurrent: () => void,
  operation: () => Promise<T>
): Promise<T> {
  Reflect.set(globalThis, '__noteRestorePreparedEntered', true);
  const authority = authorityFor(receipt);
  assertReceiptNote(authority, capability, note, accountId);
  if (preparedByClient.has(client)) throw new StorageContinuityError();
  const check = () => {
    authorityFor(receipt);
    assertCurrent();
  };
  check();
  const generation = await readSdkGeneration(client);
  Reflect.set(globalThis, '__noteRestoreGenerationRead', true);
  check();
  if (generation !== null && generation !== authority.scope.sdkGeneration) throw new StorageContinuityError();
  const prepared: PreparedReceipt = {
    ...prepareNote(file, note),
    hold: authority.hold,
    assertCurrent: check,
    acknowledge: authority.acknowledge,
    used: false
  };
  check();
  preparedByClient.set(client, prepared);
  Reflect.set(globalThis, '__noteRestorePreparedReady', true);
  try {
    const result = await operation();
    check();
    return result;
  } finally {
    if (preparedByClient.get(client) === prepared) preparedByClient.delete(client);
  }
}

function equalWord(left: string | undefined, right: string | undefined): boolean {
  return left === undefined || right === undefined
    ? left === right
    : normalizedCommitment(left) === normalizedCommitment(right);
}

export async function acknowledgeRetainedNativeNote(
  client: object | undefined,
  hold: WasmLockHold,
  candidate: NoteAcquisitionCandidate
): Promise<boolean> {
  Reflect.set(globalThis, '__noteRestoreReceiptCallback', true);
  const prepared = client ? preparedByClient.get(client) : undefined;
  if (!prepared) return false;
  prepared.assertCurrent();
  if (
    prepared.hold !== hold ||
    prepared.used ||
    candidate.source !== 'import' ||
    candidate.batchIndex !== 0 ||
    candidate.batchCount !== 1 ||
    candidate.variant !== prepared.variant ||
    !equalWord(candidate.detailsCommitment, prepared.detailsCommitment) ||
    !equalWord(candidate.noteId, prepared.noteId) ||
    !equalWord(candidate.nullifier, prepared.nullifier) ||
    candidate.tag !== prepared.tag ||
    candidate.afterBlockNum !== prepared.afterBlockNum ||
    candidate.metadata?.sender !== prepared.sender ||
    candidate.metadata?.noteType !== prepared.noteType ||
    candidate.metadata?.tag !== (prepared.variant === 'committed' ? prepared.tag : undefined) ||
    candidate.noteFileBytes.byteLength !== prepared.bytes.byteLength ||
    !candidate.noteFileBytes.every((byte, index) => byte === prepared.bytes[index])
  )
    throw new StorageContinuityError();
  Reflect.set(globalThis, '__noteRestoreReceiptMatched', true);
  prepared.used = true;
  await prepared.acknowledge?.(preparedEntry(prepared));
  prepared.assertCurrent();
  return true;
}
