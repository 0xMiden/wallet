import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { isMobile } from 'lib/platform';

import { ImportSeedPhraseScreen } from './ImportSeedPhrase';

// Unlike ImportSeedPhrase.test.tsx this renders the real TextField: the ref forwarding and
// the key wiring through it are what these tests pin.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// useScreenshotGuard withholds the grid until a native Capacitor call resolves, which never
// happens in jsdom. Force it ready so the grid renders under every isMobile() value below.
jest.mock('lib/mobile/screenshot-guard', () => ({
  useScreenshotGuard: () => true
}));

// isMobile() decides whether Enter on the last word blurs (mobile) or keeps focus (desktop).
// Mocked as a jest.fn so each test can set it; every other export is the real module.
jest.mock('lib/platform', () => ({
  ...jest.requireActual('lib/platform'),
  isMobile: jest.fn()
}));

const mockIsMobile = isMobile as jest.Mock;

const WORDS = ['abandon', 'about'];
const VALID_MNEMONIC = [...Array(11).fill('abandon'), 'about'];

const setup = (onSubmit = jest.fn()) => {
  render(<ImportSeedPhraseScreen wordslist={WORDS} onSubmit={onSubmit} />);
  const inputs = screen.getAllByRole('textbox');
  return { inputs, onSubmit };
};

beforeEach(() => {
  mockIsMobile.mockReturnValue(false);
});

describe('ImportSeedPhraseScreen keyboard', () => {
  it('renders the 12 word fields in numerical order', () => {
    const { inputs } = setup();
    expect(inputs.map(input => input.id)).toEqual(Array.from({ length: 12 }, (_, i) => `seed-phrase-input-${i}`));
  });

  it.each(Array.from({ length: 11 }, (_, i) => [i + 1, i + 2]))(
    'Enter on word %i moves focus to word %i',
    (word, nextWord) => {
      const { inputs } = setup();
      const index = word - 1;
      inputs[index]!.focus();
      fireEvent.keyDown(inputs[index]!, { key: 'Enter' });
      expect(document.activeElement).toBe(inputs[nextWord - 1]);
    }
  );

  it('Enter on word 1 moves focus to word 2 on mobile too', () => {
    mockIsMobile.mockReturnValue(true);
    const { inputs } = setup();
    inputs[0]!.focus();
    fireEvent.keyDown(inputs[0]!, { key: 'Enter' });
    expect(document.activeElement).toBe(inputs[1]);
  });

  it('Enter on word 12 leaves the grid on mobile, dismissing the keyboard', () => {
    mockIsMobile.mockReturnValue(true);
    const { inputs } = setup();
    inputs[11]!.focus();
    fireEvent.keyDown(inputs[11]!, { key: 'Enter' });
    expect(document.activeElement).toBe(document.body);
  });

  it('Enter on word 12 keeps focus on desktop, where there is no keyboard to dismiss', () => {
    const { inputs } = setup();
    inputs[11]!.focus();
    expect(fireEvent.keyDown(inputs[11]!, { key: 'Enter' })).toBe(false);
    expect(document.activeElement).toBe(inputs[11]);
  });

  it.each([
    ['mobile', true],
    ['desktop', false]
  ])('Enter on the last word does not import on %s, even with a valid phrase', (_platform, mobile) => {
    mockIsMobile.mockReturnValue(mobile);
    const { inputs, onSubmit } = setup();
    VALID_MNEMONIC.forEach((word, i) => fireEvent.change(inputs[i]!, { target: { value: word } }));
    expect(screen.getByTestId('import-seed-submit')).toBeEnabled();
    inputs[11]!.focus();
    fireEvent.keyDown(inputs[11]!, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("prevents Enter's default when moving to the next word", () => {
    const { inputs } = setup();
    inputs[0]!.focus();
    expect(fireEvent.keyDown(inputs[0]!, { key: 'Enter' })).toBe(false);
  });

  // Android's Gboard reports the Next/Done action as a trusted Enter with isComposing still
  // true, because Latin keyboards keep every word composing until it commits. That Enter must
  // still move focus, or the field the issue is about never advances on a real device.
  it("moves focus on Android's Next action while the word is still composing", () => {
    const { inputs } = setup();
    inputs[0]!.focus();
    fireEvent.keyDown(inputs[0]!, { key: 'Enter', keyCode: 13, isComposing: true });
    expect(document.activeElement).toBe(inputs[1]);
  });

  it('leaves an Enter with keyCode 229 alone, since that one only commits an IME composition', () => {
    const { inputs } = setup();
    inputs[0]!.focus();
    expect(fireEvent.keyDown(inputs[0]!, { key: 'Enter', keyCode: 229 })).toBe(true);
    expect(document.activeElement).toBe(inputs[0]);
  });

  it('does not move focus on other keys', () => {
    const { inputs } = setup();
    inputs[0]!.focus();
    expect(fireEvent.keyDown(inputs[0]!, { key: 'a' })).toBe(true);
    expect(fireEvent.keyDown(inputs[0]!, { key: 'Tab' })).toBe(true);
    expect(document.activeElement).toBe(inputs[0]);
  });
});
