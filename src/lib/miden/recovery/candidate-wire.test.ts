import { decodeRecoveryCapture } from './capture';
import { JOURNAL_MAX_BYTES } from './journal';
import { decodeSdkRecoveryCommand } from './sdk-restore';
import { decodeRetainedRecoveryNotes } from './sdk-snapshot';
import { toSerializable } from './serialization';
import type { RecoveryNoteEntry } from './types';

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
