import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { ImportSeedPhraseScreen } from './ImportSeedPhrase';

// Unlike ImportSeedPhrase.test.tsx this renders the real TextField: the ref forwarding and
// the key wiring through it are what these tests pin.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

const WORDS = ['abandon', 'about'];
const VALID_MNEMONIC = [...Array(11).fill('abandon'), 'about'];

const setup = (onSubmit = jest.fn()) => {
  render(<ImportSeedPhraseScreen wordslist={WORDS} onSubmit={onSubmit} />);
  const inputs = screen.getAllByRole('textbox');
  return { inputs, onSubmit };
};

describe('ImportSeedPhraseScreen keyboard', () => {
  it('renders the 12 word fields in numerical order', () => {
    const { inputs } = setup();
    expect(inputs.map(input => input.id)).toEqual(Array.from({ length: 12 }, (_, i) => `seed-phrase-input-${i}`));
  });

  it.each(Array.from({ length: 11 }, (_, i) => i))('Enter on word %i moves focus to the next word', index => {
    const { inputs } = setup();
    inputs[index]!.focus();
    fireEvent.keyDown(inputs[index]!, { key: 'Enter' });
    expect(document.activeElement).toBe(inputs[index + 1]);
  });

  it('Enter on the last word leaves the grid, dismissing the keyboard', () => {
    const { inputs } = setup();
    inputs[11]!.focus();
    fireEvent.keyDown(inputs[11]!, { key: 'Enter' });
    expect(document.activeElement).toBe(document.body);
  });

  it('Enter on the last word does not import, even with a valid phrase', () => {
    const { inputs, onSubmit } = setup();
    VALID_MNEMONIC.forEach((word, i) => fireEvent.change(inputs[i]!, { target: { value: word } }));
    inputs[11]!.focus();
    fireEvent.keyDown(inputs[11]!, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("prevents Enter's default, so it can never submit or insert anything", () => {
    const { inputs } = setup();
    inputs[0]!.focus();
    expect(fireEvent.keyDown(inputs[0]!, { key: 'Enter' })).toBe(false);
    inputs[11]!.focus();
    expect(fireEvent.keyDown(inputs[11]!, { key: 'Enter' })).toBe(false);
  });

  it('keeps the word in the field it leaves', () => {
    const { inputs } = setup();
    fireEvent.change(inputs[0]!, { target: { value: 'abandon' } });
    inputs[0]!.focus();
    fireEvent.keyDown(inputs[0]!, { key: 'Enter' });
    expect(inputs[0]).toHaveValue('abandon');
    expect(inputs[1]).toHaveValue('');
  });

  it('leaves an Enter that commits an IME composition alone', () => {
    const { inputs } = setup();
    inputs[0]!.focus();
    expect(fireEvent.keyDown(inputs[0]!, { key: 'Enter', isComposing: true })).toBe(true);
    expect(document.activeElement).toBe(inputs[0]);
  });

  it('does not move focus on other keys', () => {
    const { inputs } = setup();
    inputs[0]!.focus();
    fireEvent.keyDown(inputs[0]!, { key: 'a' });
    fireEvent.keyDown(inputs[0]!, { key: 'Tab' });
    expect(document.activeElement).toBe(inputs[0]);
  });
});
