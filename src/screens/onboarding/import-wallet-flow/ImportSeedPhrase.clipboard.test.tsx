import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { isMobile } from 'lib/platform';

import { ImportSeedPhraseScreen } from './ImportSeedPhrase';

// Renders the real TextField and the real secret clipboard router; only the native plugin and the
// plain clipboard are stubbed, so these tests pin the whole copy and cut path out of a seed word.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/mobile/screenshot-guard', () => ({
  useScreenshotGuard: () => true
}));

jest.mock('lib/platform', () => ({
  ...jest.requireActual('lib/platform'),
  isMobile: jest.fn()
}));

const mockNativeWrite = jest.fn();
jest.mock('@capacitor/core', () => ({
  ...jest.requireActual('@capacitor/core'),
  registerPlugin: () => ({ write: (...args: unknown[]) => mockNativeWrite(...args) })
}));

const mockClipboardWrite = jest.fn();
jest.mock('@capacitor/clipboard', () => ({
  Clipboard: { write: (...args: unknown[]) => mockClipboardWrite(...args) }
}));

const WORDS = ['abandon', 'about'];

const firstWordSelecting = (start: number, end: number) => {
  render(<ImportSeedPhraseScreen wordslist={WORDS} />);
  const field = screen.getAllByRole<HTMLInputElement>('textbox')[0]!;
  fireEvent.change(field, { target: { value: 'abandon' } });
  field.setSelectionRange(start, end);
  return field;
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(isMobile).mockReturnValue(false);
  mockNativeWrite.mockResolvedValue(undefined);
  mockClipboardWrite.mockResolvedValue(undefined);
});

describe('ImportSeedPhraseScreen clipboard', () => {
  it('on mobile, copies the selected part of a word through the secret clipboard and keeps the word', () => {
    jest.mocked(isMobile).mockReturnValue(true);
    const field = firstWordSelecting(1, 4);

    fireEvent.copy(field);

    expect(mockNativeWrite).toHaveBeenCalledWith({ string: 'ban', clearAfterMs: 60_000 });
    expect(mockClipboardWrite).not.toHaveBeenCalled();
    expect(field.value).toBe('abandon');
  });

  it('on mobile, cuts the selection through the secret clipboard and removes exactly it', () => {
    jest.mocked(isMobile).mockReturnValue(true);
    const field = firstWordSelecting(1, 4);

    fireEvent.cut(field);

    expect(mockNativeWrite).toHaveBeenCalledWith({ string: 'ban', clearAfterMs: 60_000 });
    expect(field.value).toBe('adon');
    expect([field.selectionStart, field.selectionEnd]).toEqual([1, 1]);
  });

  it('off mobile, copy puts the selection in the event data', () => {
    const field = firstWordSelecting(1, 4);
    const setData = jest.fn();

    fireEvent.copy(field, { clipboardData: { setData } });

    expect(setData).toHaveBeenCalledWith('text/plain', 'ban');
    expect(mockNativeWrite).not.toHaveBeenCalled();
    expect(field.value).toBe('abandon');
  });

  it('off mobile, cut puts the selection in the event data and removes it', () => {
    const field = firstWordSelecting(1, 4);
    const setData = jest.fn();

    fireEvent.cut(field, { clipboardData: { setData } });

    expect(setData).toHaveBeenCalledWith('text/plain', 'ban');
    expect(field.value).toBe('adon');
    expect([field.selectionStart, field.selectionEnd]).toEqual([1, 1]);
  });
});
