import React from 'react';

import { act, render, screen } from '@testing-library/react';
import { validateMnemonic } from 'bip39';

import { clearClipboard } from 'lib/ui/util';

import { SeedPhraseInput } from './SeedPhraseInput';

// --- Mocked dependencies -------------------------------------------------
// i18n is stubbed to an identity translator so assertions can match on the
// raw translation keys the component passes through.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// `bip39.validateMnemonic` is the only external gate the component consults.
// A jest.fn lets each test drive the valid/invalid branches deterministically
// without crafting real checksummed mnemonics.
jest.mock('bip39', () => ({
  validateMnemonic: jest.fn()
}));

// `../env` pulls in constate + the webextension polyfill; mock it so the
// `compact` branch can be driven directly.
const mockUseAppEnv = jest.fn();
jest.mock('../env', () => ({
  useAppEnv: () => mockUseAppEnv()
}));

// `clearClipboard` touches `navigator.clipboard`, which jsdom does not
// implement; stub it so we can assert it fires on a successful paste.
jest.mock('lib/ui/util', () => ({
  clearClipboard: jest.fn()
}));

// Child components are replaced with capturing stubs. This keeps the coverage
// surface on SeedPhraseInput itself and — crucially — lets us invoke the
// callbacks the parent wires up (including the length-select `onChange` with a
// non-numeric value, which the real select can never emit).
const mockSeedWordProps: any[] = [];
jest.mock('./SeedWordInput', () => ({
  SeedWordInput: (props: any) => {
    mockSeedWordProps[props.id] = props;
    return (
      <div
        data-testid={`seed-word-${props.id}`}
        data-value={props.value ?? ''}
        data-show-seed={String(props.showSeed)}
        data-submitted={String(props.submitted)}
        data-first={String(props.isFirstAccount)}
      />
    );
  }
}));

let mockSeedLengthProps: any = null;
jest.mock('./SeedLengthSelect', () => ({
  SeedLengthSelect: (props: any) => {
    mockSeedLengthProps = props;
    return (
      <div
        data-testid="seed-length-select"
        data-current={props.currentOption}
        data-default={props.defaultOption}
        data-options={JSON.stringify(props.options)}
      />
    );
  }
}));

const mockValidateMnemonic = validateMnemonic as jest.Mock;
const mockClearClipboard = clearClipboard as jest.Mock;

// Build a whitespace-joined raw seed of N `abandon` words.
const rawSeedOf = (n: number) => new Array(n).fill('abandon').join(' ');

// Fire the parent's `onChange` for a given word input with a trimmed value.
const changeWord = (index: number, value: string) => {
  act(() => {
    mockSeedWordProps[index].onChange({ preventDefault: jest.fn(), target: { value } });
  });
};

// Fire the parent's `onPaste` for a given word input with clipboard text.
const pasteInto = (index: number, text: string) => {
  const event = { clipboardData: { getData: () => text }, preventDefault: jest.fn() };
  act(() => {
    mockSeedWordProps[index].onPaste(event);
  });
  return event;
};

const setup = (overrides: Partial<React.ComponentProps<typeof SeedPhraseInput>> = {}) => {
  const onChange = jest.fn();
  const setSeedError = jest.fn();
  const reset = jest.fn();
  const props = {
    submitted: false,
    seedError: '',
    label: 'Import label',
    onChange,
    setSeedError,
    reset,
    ...overrides
  };
  const utils = render(<SeedPhraseInput {...props} />);
  return { ...utils, onChange, setSeedError, reset, props };
};

beforeEach(() => {
  jest.clearAllMocks();
  mockSeedWordProps.length = 0;
  mockSeedLengthProps = null;
  mockUseAppEnv.mockReturnValue({ compact: false });
  mockValidateMnemonic.mockReturnValue(false);
});

describe('SeedPhraseInput', () => {
  describe('rendering', () => {
    it('renders the label, tip, 12 word inputs and the length select with defaults', () => {
      setup({ label: 'My seed', labelWarning: 'be careful' });

      expect(screen.getByText('My seed')).toBeInTheDocument();
      expect(screen.getByText('seedPhraseTip')).toBeInTheDocument();

      // 12 word inputs by default.
      for (let i = 0; i < 12; i++) {
        expect(screen.getByTestId(`seed-word-${i}`)).toBeInTheDocument();
      }
      expect(screen.queryByTestId('seed-word-12')).not.toBeInTheDocument();

      // Length select wired with the 12..24 options and current/default = 12.
      const select = screen.getByTestId('seed-length-select');
      expect(select).toHaveAttribute('data-current', '12');
      expect(select).toHaveAttribute('data-default', '12');
      expect(mockSeedLengthProps.options).toEqual(['12', '15', '18', '21', '24']);
    });

    it('shows the label warning and 2-col grid when not the first account', () => {
      const { container } = setup({ isFirstAccount: false, labelWarning: 'restore warning' });

      expect(screen.getByText('restore warning')).toBeInTheDocument();
      expect(container.querySelector('.grid-cols-2')).toBeInTheDocument();
      expect(container.querySelector('.grid-cols-3')).not.toBeInTheDocument();
      // Children receive isFirstAccount=false.
      expect(screen.getByTestId('seed-word-0')).toHaveAttribute('data-first', 'false');
    });

    it('hides the label warning and uses a 3-col grid for the first account', () => {
      const { container } = setup({ isFirstAccount: true, labelWarning: 'restore warning' });

      expect(screen.queryByText('restore warning')).not.toBeInTheDocument();
      expect(container.querySelector('.grid-cols-3')).toBeInTheDocument();
      expect(container.querySelector('.grid-cols-2')).not.toBeInTheDocument();
      expect(screen.getByTestId('seed-word-0')).toHaveAttribute('data-first', 'true');
    });

    it('applies the compact dropdown width when the app env is compact', () => {
      mockUseAppEnv.mockReturnValue({ compact: true });
      const { container } = setup();

      const dropdownWrapper = container.querySelector('.w-64.h-10') as HTMLElement;
      expect(dropdownWrapper).toHaveStyle({ width: '220px' });
    });

    it('leaves the dropdown width unset when not compact', () => {
      const { container } = setup();

      const dropdownWrapper = container.querySelector('.w-64.h-10') as HTMLElement;
      expect(dropdownWrapper.style.width).toBe('');
    });

    it('renders the seed error only when submitted and an error is present', () => {
      const { rerender, props } = setup({ submitted: true, seedError: 'bad seed' });
      expect(screen.getByText('bad seed')).toBeInTheDocument();

      // submitted but no error -> nothing.
      rerender(<SeedPhraseInput {...props} seedError="" />);
      expect(screen.queryByText('bad seed')).not.toBeInTheDocument();

      // error present but not submitted -> nothing.
      rerender(<SeedPhraseInput {...props} submitted={false} seedError="bad seed" />);
      expect(screen.queryByText('bad seed')).not.toBeInTheDocument();
    });
  });

  describe('onSeedWordChange / onSeedChange', () => {
    it('flags an incomplete phrase when some but not all words are filled', () => {
      const { onChange, setSeedError } = setup();

      changeWord(0, 'abandon');

      // The trimmed value is stored and pushed back to the child.
      expect(screen.getByTestId('seed-word-0')).toHaveAttribute('data-value', 'abandon');
      expect(setSeedError).toHaveBeenLastCalledWith('mnemonicWordsAmountConstraint');
      expect(onChange).toHaveBeenLastCalledWith('');
      // The wired onChange calls preventDefault first.
      expect(mockSeedWordProps[0].onChange).toBeDefined();
    });

    it('clears the error and emits the phrase when all words form a valid mnemonic', () => {
      mockValidateMnemonic.mockReturnValue(true);
      const { onChange, setSeedError } = setup();

      const raw = rawSeedOf(12);
      pasteInto(0, raw);

      expect(setSeedError).toHaveBeenLastCalledWith('');
      expect(onChange).toHaveBeenLastCalledWith(raw);
      expect(mockClearClipboard).toHaveBeenCalledTimes(1);
    });

    it('flags an invalid (but complete) mnemonic', () => {
      mockValidateMnemonic.mockReturnValue(false);
      const { onChange, setSeedError } = setup();

      pasteInto(0, rawSeedOf(12));

      expect(setSeedError).toHaveBeenLastCalledWith('justValidPreGeneratedMnemonic');
      expect(onChange).toHaveBeenLastCalledWith('');
    });

    it('emits no error for an entirely empty phrase', () => {
      const { onChange, setSeedError } = setup();

      // Set then clear a word so onSeedChange runs with all-empty input.
      changeWord(0, 'abandon');
      onChange.mockClear();
      setSeedError.mockClear();
      changeWord(0, '');

      expect(setSeedError).toHaveBeenLastCalledWith('');
      // No error -> the joined (empty-word) phrase is emitted, not ''.
      expect(onChange).toHaveBeenLastCalledWith(new Array(12).fill('').join(' '));
    });
  });

  describe('onSeedPaste', () => {
    it('rejects a paste of more than 24 words and surfaces the too-many message', () => {
      const { onChange } = setup();

      pasteInto(0, rawSeedOf(25));

      expect(screen.getByText('seedPasteFailedTooManyWords')).toBeInTheDocument();
      // Early return -> no seed change / clipboard clear.
      expect(onChange).not.toHaveBeenCalled();
      expect(mockClearClipboard).not.toHaveBeenCalled();
    });

    it('clears the too-many flag when the user then edits a word', () => {
      setup();

      pasteInto(0, rawSeedOf(25));
      expect(screen.getByText('seedPasteFailedTooManyWords')).toBeInTheDocument();

      changeWord(0, 'abandon');
      expect(screen.queryByText('seedPasteFailedTooManyWords')).not.toBeInTheDocument();
    });

    it('recovers from a too-many paste when a subsequent valid paste arrives', () => {
      mockValidateMnemonic.mockReturnValue(true);
      const { onChange } = setup();

      pasteInto(0, rawSeedOf(25));
      expect(screen.getByText('seedPasteFailedTooManyWords')).toBeInTheDocument();

      const raw = rawSeedOf(12);
      pasteInto(0, raw);

      expect(screen.queryByText('seedPasteFailedTooManyWords')).not.toBeInTheDocument();
      expect(onChange).toHaveBeenLastCalledWith(raw);
      expect(mockClearClipboard).toHaveBeenCalledTimes(1);
    });

    it('grows a short paste up to 12 words and pads the remainder', () => {
      const { onChange } = setup();

      pasteInto(0, rawSeedOf(6));

      // Still 12 inputs (padded), current option reflects padded length.
      expect(screen.getByTestId('seed-word-11')).toBeInTheDocument();
      expect(screen.queryByTestId('seed-word-12')).not.toBeInTheDocument();
      // 6 real words + 6 empty -> incomplete-phrase error, onChange('').
      expect(onChange).toHaveBeenLastCalledWith('');
      const joined = onChange.mock.calls.at(-1)![0];
      expect(joined).toBe('');
    });

    it('keeps the exact length for a multiple-of-three paste (15 words)', () => {
      mockValidateMnemonic.mockReturnValue(true);
      const { onChange } = setup();

      const raw = rawSeedOf(15);
      pasteInto(0, raw);

      // Grid grows to 15 inputs, no padding needed.
      expect(screen.getByTestId('seed-word-14')).toBeInTheDocument();
      expect(screen.queryByTestId('seed-word-15')).not.toBeInTheDocument();
      expect(screen.getByTestId('seed-length-select')).toHaveAttribute('data-current', '15');
      expect(onChange).toHaveBeenLastCalledWith(raw);
    });

    it('rounds a non-multiple-of-three paste up to the next multiple and pads (13 -> 15)', () => {
      const { onChange } = setup();

      pasteInto(0, rawSeedOf(13));

      // Rounded up to 15 inputs, 13 filled + 2 padded.
      expect(screen.getByTestId('seed-word-14')).toBeInTheDocument();
      expect(screen.queryByTestId('seed-word-15')).not.toBeInTheDocument();
      // 13 filled + 2 empty -> incomplete-phrase error.
      expect(onChange).toHaveBeenLastCalledWith('');
    });
  });

  describe('word input onPaste guard', () => {
    it('ignores a single-word paste that contains no whitespace', () => {
      const { onChange } = setup();

      const event = pasteInto(0, 'singleword');

      // No whitespace -> not treated as a full-phrase paste.
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
      expect(mockClearClipboard).not.toHaveBeenCalled();
    });

    it('prevents default and processes a multi-word paste', () => {
      mockValidateMnemonic.mockReturnValue(true);
      setup();

      const event = pasteInto(0, rawSeedOf(12));

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockClearClipboard).toHaveBeenCalledTimes(1);
    });
  });

  describe('SeedLengthSelect onChange', () => {
    it('resets to the chosen number of empty words', () => {
      const { onChange, setSeedError, reset } = setup();

      act(() => {
        mockSeedLengthProps.onChange('18');
      });

      // Grid re-rendered with 18 inputs.
      expect(screen.getByTestId('seed-word-17')).toBeInTheDocument();
      expect(screen.queryByTestId('seed-word-18')).not.toBeInTheDocument();
      // All-empty -> no error, joined empty phrase emitted, reset invoked.
      expect(setSeedError).toHaveBeenLastCalledWith('');
      expect(onChange).toHaveBeenLastCalledWith(new Array(18).fill('').join(' '));
      expect(reset).toHaveBeenCalledTimes(1);
    });

    it('throws when the selected option is not a parseable integer', () => {
      setup();

      expect(() => mockSeedLengthProps.onChange('not-a-number')).toThrow('Unable to parse option as integer');
    });
  });

  it('propagates showSeed / submitted state down to word inputs', () => {
    setup({ submitted: true });

    const first = screen.getByTestId('seed-word-0');
    expect(first).toHaveAttribute('data-submitted', 'true');
    expect(first).toHaveAttribute('data-show-seed', 'true');

    // After a successful paste showSeed is turned off.
    mockValidateMnemonic.mockReturnValue(true);
    pasteInto(0, rawSeedOf(12));
    expect(screen.getByTestId('seed-word-0')).toHaveAttribute('data-show-seed', 'false');
  });
});
