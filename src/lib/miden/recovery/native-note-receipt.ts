import type { NoteAcquisitionCandidate, NoteFile } from '@miden-sdk/miden-sdk/lazy';

import { StorageContinuityError } from './continuity';
import { JOURNAL_MAX_BYTES } from './journal';
import { readSdkGeneration, type RecoverySdkReader } from './sdk-snapshot';
import { toSerializable } from './serialization';
import type { RecoveryJournalSnapshot, RecoveryNoteEntry } from './types';
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
}
interface PreparedReceipt {
  authority: RetainedNoteReceipt;
  hold: WasmLockHold;
  assertCurrent: () => void;
  bytes: Uint8Array;
  variant: 'expectedNote' | 'committed';
  detailsCommitment: string;
  noteId?: string;
  nullifier?: string;
  tag?: number;
  afterBlockNum?: number;
  sender?: string;
  noteType?: number;
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
  const authority = authorityFor(receipt);
  if (
    authority.capability !== capability ||
    authority.accountId !== accountId ||
    authority.fingerprint !== JSON.stringify(toSerializable(note)) ||
    preparedByClient.has(client)
  )
    throw new StorageContinuityError();
  const check = () => {
    authorityFor(receipt);
    assertCurrent();
  };
  check();
  const generation = await readSdkGeneration(client);
  check();
  if (generation !== null && generation !== authority.scope.sdkGeneration) throw new StorageContinuityError();
  const full = file.note();
  const details = file.noteDetails();
  const identifier = file.noteId();
  const metadata = full?.metadata();
  const sender = metadata?.sender();
  const tag = metadata?.tag() ?? file.noteTag();
  let prepared: PreparedReceipt;
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
    prepared = {
      authority: receipt,
      hold: authority.hold,
      assertCurrent: check,
      bytes,
      variant: full ? 'committed' : 'expectedNote',
      detailsCommitment,
      noteId,
      nullifier: file.nullifier(),
      tag: tag?.asU32(),
      afterBlockNum: file.afterBlockNum(),
      sender: sender?.toString(),
      noteType: metadata?.noteType(),
      used: false
    };
  } finally {
    tag?.free();
    sender?.free();
    metadata?.free();
    identifier?.free();
    details?.free();
    full?.free();
  }
  check();
  preparedByClient.set(client, prepared);
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

export function acknowledgeRetainedNativeNote(
  client: object | undefined,
  hold: WasmLockHold,
  candidate: NoteAcquisitionCandidate
): boolean {
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
  prepared.used = true;
  prepared.assertCurrent();
  return true;
}
