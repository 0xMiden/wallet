import { Address, NoteType } from '@miden-sdk/miden-sdk';

import { NoteTypeEnum, NoteType as NoteTypeString } from './types';

export function isAddressValid(address: string) {
  try {
    Address.fromBech32(address);
    return true;
  } catch {
    return false;
  }
}

export const toNoteTypeString = (noteType: NoteType) =>
  noteType === NoteType.Public ? NoteTypeEnum.Public : NoteTypeEnum.Private;

export const toNoteType = (noteType: NoteTypeString) => (noteType === 'public' ? NoteType.Public : NoteType.Private);
