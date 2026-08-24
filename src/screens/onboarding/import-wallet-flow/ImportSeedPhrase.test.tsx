import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { ImportSeedPhraseScreen } from './ImportSeedPhrase';

// --- Mocked dependencies -------------------------------------------------
// i18n is stubbed to an identity translator so assertions can match on the
// raw translation keys the component passes through.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// `t` is mocked to echo the key, so this is what the screen renders. Named
// rather than inlined so the locale check below asserts the same string the
// component asks for — the key shipped without an `en.json` entry once, and
// users saw the raw key in place of the message.
const SEED_WORD_ERROR_KEY = 'importSeedPhraseError';

// The child `Input` is replaced with a capturing stub. This keeps the coverage
// surface on `ImportSeedPhraseScreen` itself and — following the sibling
// SeedPhraseInput test — lets us invoke the exact `onChange` / `onPaste`
// callbacks the parent wires up, indexed by the `seed-phrase-input-N` id.
const mockInputProps: any[] = [];
jest.mock('components/Input', () => ({
  Input: (props: any) => {
    const index = Number(String(props.id).replace('seed-phrase-input-', ''));
    mockInputProps[index] = props;
    return (
      <input
        data-testid={props.id}
        data-prefix={props.prefix}
        value={props.value ?? ''}
        onChange={props.onChange}
        onPaste={props.onPaste}
      />
    );
  }
}));

// The child `Button` is stubbed so we can (a) read its `disabled`/`title`
// props and (b) invoke its `onClick` directly — bypassing the native disabled
// gate so the invalid-phrase branch of `handleSubmit` is reachable.
let mockButtonProps: any = null;
jest.mock('components/Button', () => ({
  Button: (props: any) => {
    mockButtonProps = props;
    return (
      <button data-testid="submit-button" disabled={props.disabled} onClick={props.onClick}>
        {props.title}
      </button>
    );
  }
}));

// 12 distinct valid words drawn from the BIP-39 English list. `wordslist` is
// whatever we hand the component, so per-word membership is deterministic.
// These words all pass wordlist membership but the phrase FAILS the BIP-39
// checksum — the exact class of input the regression guards against.
const WORDS = [
  'abandon',
  'ability',
  'able',
  'about',
  'above',
  'absent',
  'absorb',
  'abstract',
  'absurd',
  'abuse',
  'access',
  'accident'
];

// Canonical BIP-39 test vector: 11x "abandon" + "about" is checksum-valid.
// Every word is also present in `WORDS`, so `wordslist={WORDS}` accepts it.
const VALID_MNEMONIC = [...Array(11).fill('abandon'), 'about'];

const changeWord = (index: number, value: string) => {
  act(() => {
    mockInputProps[index].onChange({ target: { value } });
  });
};

const pasteInto = (index: number, text: string) => {
  const event = { preventDefault: jest.fn(), clipboardData: { getData: () => text } };
  act(() => {
    mockInputProps[index].onPaste(event);
  });
  return event;
};

const fillPhrase = (words: string[]) => {
  words.forEach((word, i) => changeWord(i, word));
};

const fillValidPhrase = () => fillPhrase(VALID_MNEMONIC);

const setup = (overrides: Partial<React.ComponentProps<typeof ImportSeedPhraseScreen>> = {}) =>
  render(<ImportSeedPhraseScreen wordslist={WORDS} {...overrides} />);

beforeEach(() => {
  jest.clearAllMocks();
  mockInputProps.length = 0;
  mockButtonProps = null;
});

describe('ImportSeedPhraseScreen', () => {
  describe('rendering', () => {
    it('renders the headings, 12 prefixed inputs and a disabled continue button by default', () => {
      const { container } = setup();

      // Root container + translated static copy.
      expect(screen.getByTestId('import-seed-phrase')).toBeInTheDocument();
      expect(screen.getByText('importWallet')).toBeInTheDocument();
      expect(screen.getByText('enterYourWalletSeedPhrase')).toBeInTheDocument();
      expect(screen.getByText('onlyMidenSeedPhrasesAreSupported')).toBeInTheDocument();

      // Exactly 12 word inputs, each with the right id and 1-based prefix.
      expect(mockInputProps).toHaveLength(12);
      expect(screen.queryByTestId('seed-phrase-input-12')).not.toBeInTheDocument();
      for (let i = 0; i < 12; i++) {
        expect(screen.getByTestId(`seed-phrase-input-${i}`)).toHaveAttribute('data-prefix', `${i + 1}.`);
      }

      // Submit button disabled while the phrase is incomplete/invalid.
      const button = screen.getByTestId('submit-button');
      expect(button).toHaveTextContent('continue');
      expect(button).toBeDisabled();
      expect(mockButtonProps.disabled).toBe(true);

      // No error message for an entirely empty phrase and no isError prop.
      expect(screen.queryByText(SEED_WORD_ERROR_KEY)).not.toBeInTheDocument();
      expect(container).toBeTruthy();
    });

    it('merges an extra className onto the root container', () => {
      setup({ className: 'my-extra-class' });

      expect(screen.getByTestId('import-seed-phrase')).toHaveClass('my-extra-class');
    });
  });

  describe('per-word validation (errorsMap / isError)', () => {
    it('flags a word that is not in the wordslist and shows the error message', () => {
      setup();

      changeWord(0, 'not-a-real-word');

      // The typed value is stored and pushed back to the child.
      expect(mockInputProps[0].value).toBe('not-a-real-word');
      // Unknown word -> errorsMap[0] true -> isError true -> error <p> rendered.
      expect(screen.getByText(SEED_WORD_ERROR_KEY)).toBeInTheDocument();
      // Phrase still invalid -> submit disabled.
      expect(mockButtonProps.disabled).toBe(true);
    });

    it('does not flag a known word from the wordslist', () => {
      setup();

      changeWord(0, 'abandon');

      expect(mockInputProps[0].value).toBe('abandon');
      // Known word -> no per-word error. Phrase incomplete -> still no error banner.
      expect(screen.queryByText(SEED_WORD_ERROR_KEY)).not.toBeInTheDocument();
      expect(mockButtonProps.disabled).toBe(true);
    });

    it('surfaces a distinct checksum error (not the wordlist-typo error) when all words are known but the phrase is invalid', () => {
      setup();

      // All words are in the wordlist, so there is no per-word typo error, but
      // the phrase fails the BIP-39 checksum.
      fillPhrase(WORDS);

      expect(screen.getByText('justValidPreGeneratedMnemonic')).toBeInTheDocument();
      expect(screen.queryByText(SEED_WORD_ERROR_KEY)).not.toBeInTheDocument();
    });

    it('shows the error banner from the isError prop even when every word is empty/valid', () => {
      setup({ isError: true });

      // No word-level errors, but the isError prop forces the banner (|| branch).
      expect(screen.getByText(SEED_WORD_ERROR_KEY)).toBeInTheDocument();
    });
  });

  describe('submit (handleSubmit / isValid)', () => {
    it('enables submit and emits the space-joined phrase when every word is valid', () => {
      const onSubmit = jest.fn();
      setup({ onSubmit });

      fillValidPhrase();

      // Every word is in the wordslist AND the checksum is valid -> button
      // enabled, no error.
      expect(mockButtonProps.disabled).toBe(false);
      expect(screen.getByTestId('submit-button')).toBeEnabled();
      expect(screen.queryByText(SEED_WORD_ERROR_KEY)).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId('submit-button'));

      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onSubmit).toHaveBeenCalledWith(VALID_MNEMONIC.join(' '));
    });

    it('keeps submit disabled and never emits for a checksum-invalid phrase whose words are all known', () => {
      const onSubmit = jest.fn();
      setup({ onSubmit });

      // Every word is in the wordslist but the phrase fails the BIP-39 checksum
      // (the "repeated word" / arbitrary-12-words case from the bug report).
      fillPhrase(WORDS);

      expect(mockButtonProps.disabled).toBe(true);
      expect(screen.getByTestId('submit-button')).toBeDisabled();

      // Bypass the disabled attribute: the handler guard must still refuse.
      act(() => {
        mockButtonProps.onClick();
      });
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('does not call onSubmit while the phrase is invalid (isValid false branch)', () => {
      const onSubmit = jest.fn();
      setup({ onSubmit });

      // Invoke onClick directly to bypass the disabled attribute and exercise
      // the guard: onSubmit is truthy but isValid is false.
      act(() => {
        mockButtonProps.onClick();
      });

      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('does not throw when submitting a valid phrase with no onSubmit handler', () => {
      setup();

      fillValidPhrase();
      expect(mockButtonProps.disabled).toBe(false);

      // onSubmit is undefined -> the `onSubmit && isValid` guard short-circuits.
      expect(() =>
        act(() => {
          mockButtonProps.onClick();
        })
      ).not.toThrow();
    });
  });

  describe('paste (onInputPaste)', () => {
    it('prevents default, splits the clipboard phrase on delimiters and populates the inputs', () => {
      const onSubmit = jest.fn();
      setup({ onSubmit });

      const event = pasteInto(0, VALID_MNEMONIC.join(' '));

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      // All 12 words distributed across the inputs.
      VALID_MNEMONIC.forEach((word, i) => expect(mockInputProps[i].value).toBe(word));
      // Full valid phrase -> button enabled and submit emits the joined phrase.
      expect(mockButtonProps.disabled).toBe(false);

      fireEvent.click(screen.getByTestId('submit-button'));
      expect(onSubmit).toHaveBeenCalledWith(VALID_MNEMONIC.join(' '));
    });

    it('trims surrounding whitespace and splits on the mixed delimiter set', () => {
      setup();

      // Leading/trailing whitespace is trimmed; commas/semicolons split words.
      pasteInto(0, '  abandon,ability;able  ');

      expect(mockInputProps[0].value).toBe('abandon');
      expect(mockInputProps[1].value).toBe('ability');
      expect(mockInputProps[2].value).toBe('able');
      // Only three words were pasted; the remaining slots are padded with ''.
      expect(mockInputProps[3].value).toBe('');
      expect(screen.getByTestId('seed-phrase-input-3')).toHaveValue('');
    });

    it('lowercases pasted words and keeps the input array at 12 entries', () => {
      setup();

      pasteInto(0, VALID_MNEMONIC.map(w => w.toUpperCase()).join(' ') + ' extra');

      VALID_MNEMONIC.forEach((word, i) => expect(mockInputProps[i].value).toBe(word));
      // Words beyond the 12th are dropped rather than growing the array.
      expect(mockInputProps).toHaveLength(12);
      expect(mockButtonProps.disabled).toBe(false);
    });
  });

  describe('typed input normalization', () => {
    it('lowercases typed words and strips whitespace', () => {
      setup();

      changeWord(0, ' Abandon ');

      expect(mockInputProps[0].value).toBe('abandon');
      expect(screen.queryByText(SEED_WORD_ERROR_KEY)).not.toBeInTheDocument();
    });
  });
  describe('localization', () => {
    it('defines the seed-word error message in the English locale', () => {
      // Regression: the component shipped calling `t('importSeedPhraseError')`
      // with no matching entry, so anyone pasting a non-wordlist word was shown
      // the literal key. Asserting through the same constant the render path
      // uses keeps the two from drifting apart again.
      const locale: Record<string, string | undefined> = require('../../../../public/_locales/en/en.json');
      const message = locale[SEED_WORD_ERROR_KEY];

      expect(typeof message).toBe('string');
      expect(message).not.toBe('');
      expect(message).not.toBe(SEED_WORD_ERROR_KEY);
    });
  });
});
