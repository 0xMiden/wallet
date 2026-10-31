import { decodeRecoveryCapture } from './capture';
import { JOURNAL_MAX_BYTES } from './journal';
import { decodeSdkRecoveryCommand, type SdkRecoveryCommand } from './sdk-restore';
import { decodeRetainedRecoveryNotes, decodeSdkRecoverySnapshot } from './sdk-snapshot';
import { fromSerializable, toSerializable } from './serialization';
import type { RecoveryNoteEntry } from './types';
import { getStorageHealth } from '../storage-health';

jest.mock('./serialization', () => {
  const actual = jest.requireActual<typeof import('./serialization')>('./serialization');
  return { ...actual, fromSerializable: jest.fn(actual.fromSerializable) };
});

beforeEach(() => jest.mocked(fromSerializable).mockClear());

describe.each(['capture', 'retained notes', 'restore command'])('Task4C3D nested candidate bounds at %s', boundary => {
  it.each(['bytes', 'count'])('refuses the aggregate %s before SDK or storage work', limit => {
    const note: RecoveryNoteEntry = {
      kind: 'note',
      id: 'primary',
      provenance: 'input',
      noteFile: new Uint8Array([1]),
      candidates: Array.from({ length: limit === 'bytes' ? 1 : boundary === 'restore command' ? 256 : 255 }, () => ({
        id: 'primary',
        provenance: 'input',
        noteFile: limit === 'bytes' ? new Uint8Array(JOURNAL_MAX_BYTES) : new Uint8Array([2])
      }))
    };
    const notes = [note, { kind: 'note', id: 'second', provenance: 'input', noteFile: new Uint8Array([3]) }];
    const decode = () => {
      if (boundary === 'capture')
        return decodeRecoveryCapture(toSerializable({ requestBytes: new Uint8Array([9]), notes }));
      if (boundary === 'retained notes') return decodeRetainedRecoveryNotes(toSerializable(notes));
      return decodeSdkRecoveryCommand(toSerializable({ kind: 'note', note, accountId: 'retained' }));
    };
    expect(decode).toThrow();
  });
});

describe.each(['capture', 'retained notes', 'restore command', 'snapshot response'])(
  'Task4C3H raw preallocation at %s',
  boundary => {
    it.each(['bytes', 'count'])('refuses aggregate %s before generic decoding and stays healthy', limit => {
      const note: RecoveryNoteEntry = {
        kind: 'note',
        id: 'primary',
        provenance: 'input',
        noteFile: new Uint8Array([1]),
        candidates: Array.from({ length: limit === 'bytes' ? 1 : boundary === 'restore command' ? 256 : 255 }, () => ({
          id: 'primary',
          provenance: 'input',
          noteFile: limit === 'bytes' ? new Uint8Array(JOURNAL_MAX_BYTES) : new Uint8Array([2])
        }))
      };
      const notes = [note, { kind: 'note', id: 'second', provenance: 'input', noteFile: new Uint8Array([3]) }];
      const wire = toSerializable(
        boundary === 'capture'
          ? { requestBytes: new Uint8Array([9]), notes }
          : boundary === 'restore command'
            ? { kind: 'note', note, accountId: 'retained' }
            : boundary === 'snapshot response'
              ? { generation: 'sdk-1', accounts: [{ accountId: 'retained', nonce: '4', commitment: 'state-4' }], notes }
              : notes
      );
      const decode = () => {
        if (boundary === 'capture') return decodeRecoveryCapture(wire);
        if (boundary === 'retained notes') return decodeRetainedRecoveryNotes(wire);
        if (boundary === 'restore command') return decodeSdkRecoveryCommand(wire);
        return decodeSdkRecoverySnapshot(wire);
      };
      expect(getStorageHealth().status).toBe('healthy');
      expect(decode).toThrow();
      expect(fromSerializable).not.toHaveBeenCalled();
      expect(getStorageHealth().status).toBe('healthy');
    });
  }
);

describe('Task4C3H account command wire', () => {
  function accountCommand(accountBytes = new Uint8Array([19, 48, 91])): SdkRecoveryCommand {
    return {
      kind: 'account',
      material: {
        floor: { accountId: 'retained', nonce: '4', commitment: 'state-4' },
        accountBytes,
        guardianCommitment: '11'.repeat(32),
        signerCommitments: ['22'.repeat(32)],
        chainCommitment: '33'.repeat(32)
      }
    };
  }

  it('preserves typed account bytes across the authorized restore wire roundtrip', () => {
    const command = accountCommand();
    const wire = toSerializable(command);
    let decoded: SdkRecoveryCommand | undefined;
    expect(() => {
      decoded = decodeSdkRecoveryCommand(wire);
    }).not.toThrow();
    expect(decoded).toEqual(command);
    expect(getStorageHealth().status).toBe('healthy');
  });

  it('refuses oversized account bytes before generic decoding and stays healthy', () => {
    const wire = toSerializable(accountCommand(new Uint8Array(JOURNAL_MAX_BYTES + 1)));
    expect(() => decodeSdkRecoveryCommand(wire)).toThrow();
    expect(fromSerializable).not.toHaveBeenCalled();
    expect(getStorageHealth().status).toBe('healthy');
  });
});
