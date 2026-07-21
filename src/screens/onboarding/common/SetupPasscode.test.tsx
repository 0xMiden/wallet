import React from 'react';

import { render, screen, fireEvent, act } from '@testing-library/react';

import SetupPasscodeScreen, {
  SetupPasscodeScreen as NamedSetupPasscodeScreen,
  SetupPasscodePhase
} from './SetupPasscode';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// `react-i18next` pulls in the full i18n runtime; stub `useTranslation` so
// `t(key)` echoes the key back and every rendered label is the raw key.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// `Numpad` — replace the real component (which pulls in icons + native
// haptics) with a lightweight keypad that exposes a button per digit plus a
// delete button, forwarding `onDigit`/`onDelete` so the passcode entry flow
// can be driven from the tests.
jest.mock('components/Numpad', () => ({
  Numpad: ({ onDigit, onDelete }: { onDigit: (d: string) => void; onDelete: () => void }) => (
    <div data-testid="numpad">
      {['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].map(d => (
        <button key={d} data-testid={`numpad-${d}`} onClick={() => onDigit(d)}>
          {d}
        </button>
      ))}
      <button data-testid="numpad-delete" onClick={onDelete}>
        del
      </button>
    </div>
  )
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PASSCODE_TRANSITION_MS = 150;

/** Advance the passcode auto-advance / submit timers, wrapped in `act`. */
const flushTimers = (ms = PASSCODE_TRANSITION_MS) =>
  act(() => {
    jest.advanceTimersByTime(ms);
  });

/** Click the numpad button for each character of `code` in order. */
const typeCode = (code: string) => {
  for (const digit of code) {
    fireEvent.click(screen.getByTestId(`numpad-${digit}`));
  }
};

const pressDelete = () => fireEvent.click(screen.getByTestId('numpad-delete'));

/** Count the number of "filled" passcode dots currently rendered. */
const filledDotCount = (container: HTMLElement) => container.querySelectorAll('div.bg-\\[\\#C7C7CC\\]').length;

const renderComponent = (props: Partial<React.ComponentProps<typeof SetupPasscodeScreen>> = {}) =>
  render(<SetupPasscodeScreen {...props} />);

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SetupPasscodeScreen', () => {
  describe('initial "enter" phase render', () => {
    it('renders the onboarding container with its test id', () => {
      renderComponent();
      expect(screen.getByTestId('onboarding-setup-passcode')).toBeInTheDocument();
    });

    it('renders the enter-phase heading and instruction copy', () => {
      renderComponent();
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('setUpYourPasscode');
      expect(screen.getByText('createA6DigitCode')).toBeInTheDocument();
    });

    it('renders six empty dots and the numpad', () => {
      const { container } = renderComponent();
      // 6 dots total, none filled initially.
      expect(container.querySelectorAll('div.rounded-full')).toHaveLength(6);
      expect(filledDotCount(container)).toBe(0);
      expect(screen.getByTestId('numpad')).toBeInTheDocument();
    });

    it('notifies onPhaseChange with the initial "enter" phase on mount', () => {
      const onPhaseChange = jest.fn();
      renderComponent({ onPhaseChange });
      expect(onPhaseChange).toHaveBeenCalledWith('enter');
    });

    it('does not throw on mount when onPhaseChange is omitted (optional chaining)', () => {
      expect(() => renderComponent()).not.toThrow();
    });
  });

  describe('digit entry and deletion (enter phase)', () => {
    it('fills one dot per digit pressed', () => {
      const { container } = renderComponent();
      typeCode('123');
      expect(filledDotCount(container)).toBe(3);
    });

    it('removes the last digit on delete', () => {
      const { container } = renderComponent();
      typeCode('123');
      pressDelete();
      expect(filledDotCount(container)).toBe(2);
    });

    it('deleting past the start stays at zero (slice on empty string)', () => {
      const { container } = renderComponent();
      pressDelete();
      expect(filledDotCount(container)).toBe(0);
    });

    it('caps entry at six digits and ignores extra presses', () => {
      const { container } = renderComponent();
      // Enter the 6th digit but do NOT advance the timer, so the component
      // stays in the "enter" phase with a full 6-digit code.
      typeCode('123456');
      expect(filledDotCount(container)).toBe(6);
      // 7th press hits the `prev.length >= PASSCODE_LENGTH ? prev` branch.
      fireEvent.click(screen.getByTestId('numpad-7'));
      expect(filledDotCount(container)).toBe(6);
    });
  });

  describe('phase transition enter -> confirm', () => {
    it('advances to the confirm phase after a full code and the timeout', () => {
      const onPhaseChange = jest.fn();
      const { container } = renderComponent({ onPhaseChange });

      typeCode('123456');
      // Before the timer fires the heading is still the enter copy.
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('setUpYourPasscode');

      flushTimers();

      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('confirmYourPasscode');
      expect(screen.getByText('reEnterTheSame6Digits')).toBeInTheDocument();
      // Confirm code starts empty -> no filled dots.
      expect(filledDotCount(container)).toBe(0);
      expect(onPhaseChange).toHaveBeenLastCalledWith('confirm');
    });

    it('clears the pending transition timer on unmount (no phase change fires late)', () => {
      const onPhaseChange = jest.fn();
      const { unmount } = renderComponent({ onPhaseChange });

      typeCode('123456');
      unmount();
      // The cleanup cleared the timer; advancing does nothing further.
      flushTimers();
      expect(onPhaseChange).not.toHaveBeenCalledWith('confirm');
    });
  });

  describe('confirm phase — matching code (success)', () => {
    const advanceToConfirm = () => {
      typeCode('123456');
      flushTimers();
    };

    it('invokes onSubmit with the confirmed code once the codes match', () => {
      const onSubmit = jest.fn();
      renderComponent({ onSubmit });

      advanceToConfirm();
      typeCode('123456');
      flushTimers();

      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onSubmit).toHaveBeenCalledWith('123456');
    });

    it('does not throw when the codes match but onSubmit is omitted', () => {
      renderComponent();

      advanceToConfirm();
      typeCode('123456');
      expect(() => flushTimers()).not.toThrow();
    });

    it('clears the pending submit timer on unmount (onSubmit never fires)', () => {
      const onSubmit = jest.fn();
      const { unmount } = renderComponent({ onSubmit });

      advanceToConfirm();
      typeCode('123456');
      // Unmount with the submit timer still pending -> cleanup runs.
      unmount();
      flushTimers();
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });

  describe('confirm phase — mismatching code', () => {
    const advanceToConfirm = () => {
      typeCode('123456');
      flushTimers();
    };

    it('shows the mismatch message and resets the confirm code', () => {
      const onSubmit = jest.fn();
      const { container } = renderComponent({ onSubmit });

      advanceToConfirm();
      typeCode('111111');
      flushTimers();

      expect(screen.getByText('passcodesDoNotMatch')).toBeInTheDocument();
      expect(onSubmit).not.toHaveBeenCalled();
      // Confirm code was cleared back to empty.
      expect(filledDotCount(container)).toBe(0);
    });

    it('clears the mismatch flag when the next digit is pressed', () => {
      const { container } = renderComponent();

      advanceToConfirm();
      typeCode('111111');
      flushTimers();
      expect(screen.getByText('passcodesDoNotMatch')).toBeInTheDocument();

      // Pressing a digit hits the `if (mismatch) setMismatch(false)` branch.
      fireEvent.click(screen.getByTestId('numpad-9'));
      expect(screen.queryByText('passcodesDoNotMatch')).not.toBeInTheDocument();
      expect(screen.getByText('reEnterTheSame6Digits')).toBeInTheDocument();
      expect(filledDotCount(container)).toBe(1);
    });

    it('clears the mismatch flag when delete is pressed', () => {
      renderComponent();

      advanceToConfirm();
      typeCode('111111');
      flushTimers();
      expect(screen.getByText('passcodesDoNotMatch')).toBeInTheDocument();

      // Delete on the (empty) confirm code hits the mismatch-clearing branch.
      pressDelete();
      expect(screen.queryByText('passcodesDoNotMatch')).not.toBeInTheDocument();
      expect(screen.getByText('reEnterTheSame6Digits')).toBeInTheDocument();
    });

    it('clears the pending mismatch timer on unmount (mismatch never latches)', () => {
      const { unmount } = renderComponent();

      advanceToConfirm();
      typeCode('111111');
      // Unmount before the mismatch timer fires -> cleanup runs.
      unmount();
      expect(() => flushTimers()).not.toThrow();
    });
  });

  describe('exports and typing', () => {
    it('exposes the same component as its default and named export', () => {
      expect(NamedSetupPasscodeScreen).toBe(SetupPasscodeScreen);
    });

    it('accepts the SetupPasscodePhase union at the type level', () => {
      const phases: SetupPasscodePhase[] = ['enter', 'confirm'];
      expect(phases).toEqual(['enter', 'confirm']);
    });
  });
});
