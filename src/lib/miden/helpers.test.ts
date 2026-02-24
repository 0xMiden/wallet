import { NoteType } from '@miden-sdk/miden-sdk';

import { isAddressValid, toNoteType, toNoteTypeString } from './helpers';
import { NoteTypeEnum } from './types';

jest.mock('@miden-sdk/miden-sdk', () => ({
  NoteType: { Public: 'public', Private: 'private' },
  Address: { fromBech32: jest.fn((addr: string) => { if (addr === 'valid-bech32') return {}; throw new Error('Invalid'); }) }
}));

describe('miden helpers', () => {
  it('validates addresses using Address.fromBech32', () => {
    expect(isAddressValid('valid-bech32')).toBe(true);
    expect(isAddressValid('anything')).toBe(false);
  });

  it('converts note type enum to string and back', () => {
    expect(toNoteTypeString(NoteType.Public as any)).toBe(NoteTypeEnum.Public);
    expect(toNoteTypeString(NoteType.Private as any)).toBe(NoteTypeEnum.Private);
    expect(toNoteType(NoteTypeEnum.Public)).toBe(NoteType.Public);
    expect(toNoteType(NoteTypeEnum.Private)).toBe(NoteType.Private);
  });
});
