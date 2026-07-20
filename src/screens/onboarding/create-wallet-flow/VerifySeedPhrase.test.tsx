import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

import { VerifySeedPhraseScreen } from './VerifySeedPhrase';

// `react-i18next` pulls in the full i18n runtime; stub `useTranslation` so
// `t(key)` echoes the key back, and render `<Trans>` as its i18nKey so we can
// assert on the rendered copy directly.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <>{i18nKey}</>
}));

// `lodash.shuffle` randomizes word order, which would make selection assertions
// non-deterministic. Keep the real lodash but replace `shuffle` with an
// order-preserving copy so `shuffledWords[i]` maps to `seedPhrase[i]`.
jest.mock('lodash', () => ({
  ...jest.requireActual('lodash'),
  shuffle: (arr: unknown[]) => [...arr]
}));

// Haptics touch native Capacitor plugins; stub to a spy.
jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

// Mock the child components so this unit test stays scoped to the screen's own
// logic (the real Toggle pulls in framer-motion). Each mock surfaces just the
// props the screen wires through.
jest.mock('components/Chip', () => ({
  Chip: ({ label, selected }: { label: string; selected?: boolean }) => (
    <span data-testid="chip" data-selected={String(!!selected)}>
      {label}
    </span>
  )
}));

jest.mock('components/Button', () => ({
  Button: ({
    title,
    onClick,
    disabled
  }: {
    title: string;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button data-testid="continue" disabled={disabled} onClick={onClick}>
      {title}
    </button>
  )
}));

jest.mock('components/Toggle', () => ({
  Toggle: ({ value, onChangeValue }: { value?: boolean; onChangeValue?: (v: boolean) => void }) => (
    <button data-testid="toggle" data-value={String(value)} onClick={() => onChangeValue && onChangeValue(!value)}>
      toggle
    </button>
  )
}));

const SEED = Array.from({ length: 12 }, (_, i) => `w${i}`);

// The wrapping <button> owns the onSelectWord handler; click by locating the
// chip label and walking up to its button.
const clickWord = (index: number) => {
  const chip = screen.getByText(`w${index}`);
  fireEvent.click(chip.closest('button') as HTMLButtonElement);
};

const wordButtonSelected = (index: number) =>
  screen.getByText(`w${index}`).getAttribute('data-selected');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('VerifySeedPhraseScreen', () => {
  describe('intro section', () => {
    it('renders the intro copy by default (showIntro defaults to true)', () => {
      render(<VerifySeedPhraseScreen seedPhrase={SEED} />);

      expect(screen.getByText('verifySeedPhrase')).toBeInTheDocument();
      expect(screen.getByText('verifyMessagePrefix')).toBeInTheDocument();
      // <Trans> mock renders its i18nKey.
      expect(screen.getByText('verifyMessageSuffix')).toBeInTheDocument();
    });

    it('hides the intro copy when showIntro is false', () => {
      render(<VerifySeedPhraseScreen seedPhrase={SEED} showIntro={false} />);

      expect(screen.queryByText('verifySeedPhrase')).not.toBeInTheDocument();
      expect(screen.queryByText('verifyMessagePrefix')).not.toBeInTheDocument();
    });
  });

  describe('rendering', () => {
    it('renders one chip per seed word and forwards root props / className', () => {
      render(<VerifySeedPhraseScreen seedPhrase={SEED} id="my-root" className="extra-class" />);

      expect(screen.getAllByTestId('chip')).toHaveLength(12);

      const root = screen.getByTestId('verify-seed-phrase');
      expect(root).toHaveAttribute('id', 'my-root');
      expect(root).toHaveClass('extra-class');
    });

    it('starts with no words selected and the continue button disabled', () => {
      render(<VerifySeedPhraseScreen seedPhrase={SEED} />);

      SEED.forEach((_, i) => expect(wordButtonSelected(i)).toBe('false'));
      expect(screen.queryByText('first')).not.toBeInTheDocument();
      expect(screen.queryByText('last')).not.toBeInTheDocument();
      expect(screen.getByTestId('continue')).toBeDisabled();
    });
  });

  describe('word selection', () => {
    it('selects the first word on the initial tap and fires haptic feedback', () => {
      render(<VerifySeedPhraseScreen seedPhrase={SEED} />);

      clickWord(0);

      expect(hapticLight).toHaveBeenCalledTimes(1);
      // firstSelectedWordIndex === 0 branch (relies on `=== 0`, not `!!index`).
      expect(screen.getByText('first')).toBeInTheDocument();
      expect(wordButtonSelected(0)).toBe('true');
    });

    it('shows the "first" badge for a non-zero first index (truthy branch)', () => {
      render(<VerifySeedPhraseScreen seedPhrase={SEED} />);

      clickWord(3);

      expect(screen.getByText('first')).toBeInTheDocument();
      expect(wordButtonSelected(3)).toBe('true');
    });

    it('unselects the first word when it is tapped again', () => {
      render(<VerifySeedPhraseScreen seedPhrase={SEED} />);

      clickWord(3);
      expect(screen.getByText('first')).toBeInTheDocument();

      clickWord(3);
      expect(screen.queryByText('first')).not.toBeInTheDocument();
      expect(wordButtonSelected(3)).toBe('false');
    });

    it('selects a second word (else branch) and badges it as "last"', () => {
      render(<VerifySeedPhraseScreen seedPhrase={SEED} />);

      clickWord(0); // first = 0
      clickWord(11); // second = 11 (positive index -> truthy `!!index` branch)

      expect(screen.getByText('first')).toBeInTheDocument();
      expect(screen.getByText('last')).toBeInTheDocument();
      expect(wordButtonSelected(11)).toBe('true');
    });

    it('shows the "last" badge for a zero second index (=== 0 branch)', () => {
      render(<VerifySeedPhraseScreen seedPhrase={SEED} />);

      clickWord(3); // first = 3
      clickWord(0); // second = 0 (0 !== first, 0 !== second) -> setSecond(0)

      expect(screen.getByText('last')).toBeInTheDocument();
      expect(wordButtonSelected(0)).toBe('true');
    });

    it('unselects the second word when it is tapped again', () => {
      render(<VerifySeedPhraseScreen seedPhrase={SEED} />);

      clickWord(3); // first = 3
      clickWord(5); // second = 5
      expect(screen.getByText('last')).toBeInTheDocument();

      clickWord(5); // index === secondSelectedWordIndex -> unselect second
      expect(screen.queryByText('last')).not.toBeInTheDocument();
      expect(wordButtonSelected(5)).toBe('false');
    });

    it('unselects the second word even after the first was cleared (first === null path)', () => {
      render(<VerifySeedPhraseScreen seedPhrase={SEED} />);

      clickWord(3); // first = 3
      clickWord(5); // second = 5
      clickWord(3); // index === first -> first = null (second stays 5)

      expect(screen.queryByText('first')).not.toBeInTheDocument();
      expect(screen.getByText('last')).toBeInTheDocument();

      // first === null, index === secondSelectedWordIndex: the opening guard's
      // `index !== secondSelectedWordIndex` is false, so it falls through to the
      // "unselect second" branch.
      clickWord(5);
      expect(screen.queryByText('last')).not.toBeInTheDocument();
      expect(wordButtonSelected(5)).toBe('false');
    });
  });

  describe('continue button / correctness', () => {
    it('enables continue only when the correct first + last words are chosen', () => {
      const onSubmit = jest.fn();
      render(<VerifySeedPhraseScreen seedPhrase={SEED} onSubmit={onSubmit} />);

      // seedPhrase[0] === 'w0' (index 0), seedPhrase[11] === 'w11' (index 11).
      clickWord(0);
      clickWord(11);

      const continueBtn = screen.getByTestId('continue');
      expect(continueBtn).not.toBeDisabled();

      fireEvent.click(continueBtn);
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('keeps continue disabled when the wrong words are chosen', () => {
      render(<VerifySeedPhraseScreen seedPhrase={SEED} />);

      clickWord(1); // wrong first word
      clickWord(2); // wrong last word

      expect(screen.getByTestId('continue')).toBeDisabled();
    });

    it('keeps continue disabled while only one word is selected', () => {
      render(<VerifySeedPhraseScreen seedPhrase={SEED} />);

      clickWord(0); // correct first, but no second selected yet

      expect(screen.getByTestId('continue')).toBeDisabled();
    });

    it('does not submit when the disabled continue button is clicked', () => {
      const onSubmit = jest.fn();
      render(<VerifySeedPhraseScreen seedPhrase={SEED} onSubmit={onSubmit} />);

      fireEvent.click(screen.getByTestId('continue'));

      expect(onSubmit).not.toHaveBeenCalled();
    });
  });

  describe('hardware security / biometric toggle', () => {
    it('does not render the biometric section by default', () => {
      render(<VerifySeedPhraseScreen seedPhrase={SEED} />);

      expect(screen.queryByTestId('toggle')).not.toBeInTheDocument();
      expect(screen.queryByText('unlockWallet')).not.toBeInTheDocument();
    });

    it('renders the biometric section and defaults the toggle to on', () => {
      const onBiometricChange = jest.fn();
      render(
        <VerifySeedPhraseScreen
          seedPhrase={SEED}
          isHardwareSecurityAvailable
          onBiometricChange={onBiometricChange}
        />
      );

      expect(screen.getByText('unlockWallet')).toBeInTheDocument();
      expect(screen.getByText('unlockWalletDescription')).toBeInTheDocument();
      expect(screen.getByText('passwordsCanBeInsecure')).toBeInTheDocument();

      const toggle = screen.getByTestId('toggle');
      // useBiometric defaults to true.
      expect(toggle).toHaveAttribute('data-value', 'true');

      fireEvent.click(toggle);
      expect(onBiometricChange).toHaveBeenCalledWith(false);
    });

    it('reflects an explicit useBiometric=false value on the toggle', () => {
      render(
        <VerifySeedPhraseScreen seedPhrase={SEED} isHardwareSecurityAvailable useBiometric={false} />
      );

      expect(screen.getByTestId('toggle')).toHaveAttribute('data-value', 'false');
    });
  });
});
