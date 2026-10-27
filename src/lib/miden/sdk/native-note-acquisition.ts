import { NoteAcquisitionRetentionError, type NoteAcquisitionOptions } from '@miden-sdk/miden-sdk/lazy';

import { assertWasmHoldCurrent, getCurrentWasmLockHold, type WasmLockHold } from './miden-client';
import { JOURNAL_MAX_BYTES, JOURNAL_MAX_ENTRIES } from '../recovery/journal';
import { acknowledgeRetainedNativeNote } from '../recovery/native-note-receipt';
import { captureNoteAcquisitionRetainer } from '../recovery/note-acquisition';
import type { RecoveryNoteEntry } from '../recovery/types';
import { assertStorageHealthy, getStorageHealth, reportStorageFailure } from '../storage-health';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function word(value: unknown): value is string {
  return typeof value === 'string' && /^(0x)?[0-9a-f]{64}$/i.test(value);
}
function normalized(value: string): string {
  return value.replace(/^0x/i, '').toLowerCase();
}
function u32(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

interface NativeBatch {
  count: number;
  nextIndex: number;
  bytes: number;
  pending: boolean;
}

function copyCandidate(
  value: unknown,
  claimBatch: (operationId: string, index: number, count: number, bytes: number) => void
): RecoveryNoteEntry[] {
  if (
    !record(value) ||
    Object.keys(value).some(
      key =>
        ![
          'operationId',
          'noteFileBytes',
          'variant',
          'source',
          'batchIndex',
          'batchCount',
          'detailsCommitment',
          'noteId',
          'nullifier',
          'metadata',
          'tag',
          'afterBlockNum'
        ].includes(key)
    ) ||
    typeof value.operationId !== 'string' ||
    value.operationId.length === 0 ||
    value.operationId.length > 128 ||
    !(value.noteFileBytes instanceof Uint8Array) ||
    value.noteFileBytes.length === 0 ||
    value.noteFileBytes.length > JOURNAL_MAX_BYTES ||
    !['noteId', 'expectedNote', 'committed'].some(variant => variant === value.variant) ||
    (value.source !== 'import' && value.source !== 'noteTransport') ||
    !u32(value.batchIndex) ||
    !u32(value.batchCount) ||
    value.batchCount === 0 ||
    value.batchCount > JOURNAL_MAX_ENTRIES ||
    value.batchIndex >= value.batchCount ||
    (value.tag !== undefined && !u32(value.tag)) ||
    (value.afterBlockNum !== undefined && !u32(value.afterBlockNum))
  )
    throw new Error('Invalid native note acquisition');
  const metadata = value.metadata;
  if (
    metadata !== undefined &&
    (!record(metadata) ||
      Object.keys(metadata).some(key => !['sender', 'noteType', 'tag', 'attachmentsCommitment'].includes(key)) ||
      typeof metadata.sender !== 'string' ||
      !/^0x[0-9a-f]{30}$/i.test(metadata.sender) ||
      (metadata.noteType !== 0 && metadata.noteType !== 1) ||
      !u32(metadata.tag) ||
      !word(metadata.attachmentsCommitment))
  )
    throw new Error('Invalid native note metadata');
  claimBatch(value.operationId, value.batchIndex, value.batchCount, value.noteFileBytes.byteLength);
  if (value.variant === 'noteId') {
    if (
      !word(value.noteId) ||
      value.detailsCommitment !== undefined ||
      value.nullifier !== undefined ||
      metadata !== undefined ||
      value.tag !== undefined ||
      value.afterBlockNum !== undefined
    )
      throw new Error('Invalid native note identity');
    return [];
  }
  if (!word(value.detailsCommitment)) throw new Error('Invalid native note details');
  if (value.variant === 'expectedNote') {
    if (value.noteId !== undefined || value.nullifier !== undefined || metadata !== undefined)
      throw new Error('Invalid native expected note');
  } else if (!word(value.noteId) || !word(value.nullifier) || value.afterBlockNum !== undefined) {
    throw new Error('Invalid native committed note');
  }
  if (record(metadata) && metadata.noteType === 1) return [];
  return [
    {
      kind: 'note',
      id: word(value.noteId) ? normalized(value.noteId) : normalized(value.detailsCommitment),
      detailsId: normalized(value.detailsCommitment),
      noteFile: value.noteFileBytes.slice(),
      provenance: 'input',
      format: value.variant === 'committed' ? 'full' : 'details'
    }
  ];
}

export function nativeNoteAcquisition(
  network: string,
  ownsClient: () => boolean,
  getClient: () => object | undefined
): NoteAcquisitionOptions {
  const batchesByHold = new WeakMap<WasmLockHold, Map<string, NativeBatch>>();
  return {
    noteAcquisitionLimits: {
      maxNotes: JOURNAL_MAX_ENTRIES,
      maxNoteFileBytes: JOURNAL_MAX_BYTES,
      maxTotalNoteFileBytes: JOURNAL_MAX_BYTES
    },
    beforeNoteAcquisition: async candidate => {
      const hold = getCurrentWasmLockHold();
      if (!hold) throw new Error('Native note acquisition has no current operation');
      const epoch = getStorageHealth().epoch;
      const retain = captureNoteAcquisitionRetainer();
      const assertOwner = () => {
        if (!ownsClient()) throw new Error('Native note acquisition owner replaced');
        assertWasmHoldCurrent(hold, 'native note acquisition');
        retain.assertSinkCurrent();
      };
      const check = () => {
        assertOwner();
        assertStorageHealthy(epoch);
      };
      assertOwner();
      let claimedBatch: NativeBatch | undefined;
      const notes = copyCandidate(candidate, (operationId, index, count, bytes) => {
        let batches = batchesByHold.get(hold);
        if (!batches) {
          batches = new Map();
          batchesByHold.set(hold, batches);
        }
        let batch = batches.get(operationId);
        if (!batch) {
          if (index !== 0 || batches.size >= JOURNAL_MAX_ENTRIES) throw new Error('Invalid native note batch start');
          batch = { count, nextIndex: 0, bytes: 0, pending: false };
          batches.set(operationId, batch);
        }
        if (
          batch.pending ||
          batch.count !== count ||
          batch.nextIndex !== index ||
          batch.bytes + bytes > JOURNAL_MAX_BYTES
        )
          throw new Error('Invalid native note batch continuation');
        batch.bytes += bytes;
        batch.pending = true;
        claimedBatch = batch;
      });
      const acknowledgeBatch = () => {
        if (claimedBatch) {
          claimedBatch.nextIndex += 1;
          claimedBatch.pending = false;
        }
      };
      if (await acknowledgeRetainedNativeNote(getClient(), hold, candidate)) {
        assertOwner();
        acknowledgeBatch();
        return;
      }
      check();
      let retentionFailure: unknown;
      try {
        await retain(notes, network, check, error => {
          retentionFailure = error;
        });
        check();
        acknowledgeBatch();
      } catch (error) {
        assertOwner();
        const health = getStorageHealth();
        if (health.epoch !== epoch && !(health.status === 'unavailable' && health.epoch === epoch + 1)) throw error;
        if (retentionFailure && reportStorageFailure(retentionFailure, { backend: 'independent', operation: 'mutate' }))
          throw new NoteAcquisitionRetentionError();
        throw error;
      }
    }
  };
}
