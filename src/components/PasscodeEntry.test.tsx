import React from 'react';

import { render, screen, fireEvent, act } from '@testing-library/react';

import PasscodeEntry, { PasscodeEntry as NamedPasscodeEntry, PASSCODE_LENGTH } from './PasscodeEntry';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// `react-i18next` pulls in the full i18n runtime; stub `useTranslation` so
// `t(key)` echoes the key back and the default hint / aria-label is the raw
// key `enterYour6DigitCode`.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// `Numpad` — replace the real component (which pulls in SVG icons + native
// haptics) with a lightweight keypad exposing a button per digit plus a delete
// button, forwarding `onDigit` / `onDelete` so passcode entry can be driven.
jest.mock('components/Numpad', () => ({
  Numpad: ({
    onDigit,
    onDelete,
    className
  }: {
    onDigit: (d: string) => void;
    onDelete: () => void;
    className?: string;
  }) => (
    <div data-testid="numpad" className={className}>
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

const AUTO_SUBMIT_MS = 150;

/** Advance the auto-submit timer, wrapped in `act`. */
const flushTimers = (ms = AUTO_SUBMIT_MS) =>
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

type Props = React.ComponentProps<typeof NamedPasscodeEntry>;

const renderComponent = (overrides: Partial<Props> = {}) => {
  const onSubmit = overrides.onSubmit ?? jest.fn();
  const props: Props = { onSubmit, ...overrides };
  const utils = render(<NamedPasscodeEntry {...props} />);
  return { ...utils, onSubmit, props };
};

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

describe('PasscodeEntry', () => {
  it('exports the passcode length constant', () => {
    expect(PASSCODE_LENGTH).toBe(6);
  });

  it('default export is the same component as the named export', () => {
    expect(PasscodeEntry).toBe(NamedPasscodeEntry);
  });

  describe('initial render', () => {
    it('renders the group container with its test id', () => {
      renderComponent();
      expect(screen.getByTestId('passcode-entry')).toBeInTheDocument();
    });

    it('renders six empty dots and the numpad', () => {
      const { container } = renderComponent();
      expect(container.querySelectorAll('div.rounded-full')).toHaveLength(PASSCODE_LENGTH);
      expect(filledDotCount(container)).toBe(0);
      expect(screen.getByTestId('numpad')).toBeInTheDocument();
    });

    it('registers every digit when several are tapped in the same tick (#468 fast typing)', () => {
      const onChange = jest.fn();
      const { container } = renderComponent({ onChange });

      // Tap three digits synchronously within one act(): React batches the state
      // updates, so a handler reading `code` from its closure sees a stale value
      // for all three taps and drops all but the last — the reported bug.
      act(() => {
        fireEvent.click(screen.getByTestId('numpad-1'));
        fireEvent.click(screen.getByTestId('numpad-2'));
        fireEvent.click(screen.getByTestId('numpad-3'));
      });

      expect(filledDotCount(container)).toBe(3);
      expect(onChange).toHaveBeenLastCalledWith('123');
    });

    it('uses the default hint and aria-label when no subtitle/error given', () => {
      renderComponent();
      expect(screen.getByRole('status')).toHaveTextContent('enterYour6DigitCode');
      expect(screen.getByRole('group')).toHaveAttribute('aria-label', 'enterYour6DigitCode');
    });

    it('renders the default (muted) hint styling with no error', () => {
      renderComponent();
      const status = screen.getByRole('status');
      expect(status).toHaveClass('text-text-muted');
      expect(status).not.toHaveClass('text-red-500');
    });

    it('forwards a custom className to the root group', () => {
      renderComponent({ className: 'my-custom-class' });
      expect(screen.getByRole('group')).toHaveClass('my-custom-class');
    });
  });

  describe('subtitle / error hint precedence', () => {
    it('shows the subtitle as the hint and aria-label when there is no error', () => {
      renderComponent({ subtitle: 'Custom subtitle' });
      expect(screen.getByRole('status')).toHaveTextContent('Custom subtitle');
      expect(screen.getByRole('group')).toHaveAttribute('aria-label', 'Custom subtitle');
      expect(screen.getByRole('status')).toHaveClass('text-text-muted');
    });

    it('shows the error hint with red styling, taking precedence over the subtitle', () => {
      renderComponent({ subtitle: 'Custom subtitle', error: 'Wrong passcode' });
      const status = screen.getByRole('status');
      expect(status).toHaveTextContent('Wrong passcode');
      expect(status).toHaveClass('text-red-500');
      expect(status).not.toHaveClass('text-text-muted');
      // aria-label still derives from subtitle, not the error.
      expect(screen.getByRole('group')).toHaveAttribute('aria-label', 'Custom subtitle');
    });

    it('treats an empty-string error as non-error (muted styling, no clearing)', () => {
      const { container } = renderComponent({ error: '' });
      typeCode('12');
      // Empty-string error is falsy, so digits are NOT cleared.
      expect(filledDotCount(container)).toBe(2);
      expect(screen.getByRole('status')).toHaveClass('text-text-muted');
    });
  });

  describe('digit entry', () => {
    it('fills a dot and reports each cumulative value via onChange', () => {
      const onChange = jest.fn();
      const { container } = renderComponent({ onChange });

      typeCode('12');

      expect(filledDotCount(container)).toBe(2);
      expect(onChange).toHaveBeenNthCalledWith(1, '1');
      expect(onChange).toHaveBeenNthCalledWith(2, '12');
    });

    it('does not throw when onChange is omitted', () => {
      const { container } = renderComponent();
      expect(() => typeCode('34')).not.toThrow();
      expect(filledDotCount(container)).toBe(2);
    });

    it('ignores presses once six digits are entered', () => {
      const onChange = jest.fn();
      const { container } = renderComponent({ onChange });

      typeCode('123456');
      expect(filledDotCount(container)).toBe(6);
      expect(onChange).toHaveBeenCalledTimes(6);

      // A seventh press is a no-op (length >= PASSCODE_LENGTH guard).
      fireEvent.click(screen.getByTestId('numpad-7'));
      expect(filledDotCount(container)).toBe(6);
      expect(onChange).toHaveBeenCalledTimes(6);
    });

    it('ignores digit presses when disabled', () => {
      const onChange = jest.fn();
      const { container } = renderComponent({ disabled: true, onChange });

      typeCode('12');
      expect(filledDotCount(container)).toBe(0);
      expect(onChange).not.toHaveBeenCalled();
    });

    it('ignores digit presses while submitting', () => {
      const onChange = jest.fn();
      const { container } = renderComponent({ isSubmitting: true, onChange });

      typeCode('12');
      expect(filledDotCount(container)).toBe(0);
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('removes the last digit and reports the shortened value via onChange', () => {
      const onChange = jest.fn();
      const { container } = renderComponent({ onChange });

      typeCode('123');
      onChange.mockClear();

      pressDelete();
      expect(filledDotCount(container)).toBe(2);
      expect(onChange).toHaveBeenCalledWith('12');
    });

    it('stays empty (and reports "") when deleting on an empty code', () => {
      const onChange = jest.fn();
      const { container } = renderComponent({ onChange });

      pressDelete();
      expect(filledDotCount(container)).toBe(0);
      expect(onChange).toHaveBeenCalledWith('');
    });

    it('does not throw when deleting without an onChange handler', () => {
      const { container } = renderComponent();
      typeCode('12');
      expect(() => pressDelete()).not.toThrow();
      expect(filledDotCount(container)).toBe(1);
    });

    it('ignores delete presses when disabled', () => {
      const onChange = jest.fn();
      const { container } = renderComponent({ disabled: true, onChange });
      pressDelete();
      expect(filledDotCount(container)).toBe(0);
      expect(onChange).not.toHaveBeenCalled();
    });

    it('ignores delete presses while submitting', () => {
      const onChange = jest.fn();
      const { container } = renderComponent({ isSubmitting: true, onChange });
      pressDelete();
      expect(filledDotCount(container)).toBe(0);
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('auto-submit', () => {
    it('fires onSubmit exactly once, ~150ms after the sixth digit', () => {
      const { onSubmit } = renderComponent();

      typeCode('123456');
      // Not yet — the timer has not elapsed.
      expect(onSubmit).not.toHaveBeenCalled();

      flushTimers(100);
      expect(onSubmit).not.toHaveBeenCalled();

      flushTimers(50);
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onSubmit).toHaveBeenCalledWith('123456');

      // Further time does not re-fire.
      flushTimers(1000);
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('does not submit before the code reaches full length', () => {
      const { onSubmit } = renderComponent();
      typeCode('12345');
      flushTimers(1000);
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('does not fire onSubmit if unmounted before the timer elapses', () => {
      const { onSubmit, unmount } = renderComponent();
      typeCode('123456');
      unmount();
      flushTimers(1000);
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('does not submit when isSubmitting becomes true before the timer elapses', () => {
      const onSubmit = jest.fn();
      const { rerender } = renderComponent({ onSubmit });

      typeCode('123456');
      rerender(<NamedPasscodeEntry onSubmit={onSubmit} isSubmitting />);
      flushTimers(1000);

      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('does not submit when disabled becomes true before the timer elapses', () => {
      const onSubmit = jest.fn();
      const { rerender } = renderComponent({ onSubmit });

      typeCode('123456');
      rerender(<NamedPasscodeEntry onSubmit={onSubmit} disabled />);
      flushTimers(1000);

      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('does not re-submit the same completed code when the parent re-renders with a new onSubmit identity', () => {
      const onSubmit = jest.fn();
      const { rerender } = renderComponent({ onSubmit });

      typeCode('123456');
      flushTimers();
      expect(onSubmit).toHaveBeenCalledTimes(1);

      // A fresh inline onSubmit + parent re-render must not re-fire the same code.
      const onSubmit2 = jest.fn();
      rerender(<NamedPasscodeEntry onSubmit={onSubmit2} />);
      flushTimers(1000);
      expect(onSubmit2).not.toHaveBeenCalled();
    });
  });

  describe('error clears the entered code', () => {
    it('clears the dots and shows the error when the error prop becomes set', () => {
      const onSubmit = jest.fn();
      const { container, rerender } = renderComponent({ onSubmit });

      typeCode('1234');
      expect(filledDotCount(container)).toBe(4);

      rerender(<NamedPasscodeEntry onSubmit={onSubmit} error="Bad passcode" />);
      expect(filledDotCount(container)).toBe(0);
      expect(screen.getByRole('status')).toHaveTextContent('Bad passcode');
    });

    it('allows re-submitting the same code after an error cleared it', () => {
      const onSubmit = jest.fn();
      const { rerender } = renderComponent({ onSubmit });

      // First attempt: complete + submit.
      typeCode('123456');
      flushTimers();
      expect(onSubmit).toHaveBeenCalledTimes(1);

      // Parent reports a failure, which clears the entered digits.
      rerender(<NamedPasscodeEntry onSubmit={onSubmit} error="Wrong" />);

      // Clear the error and re-enter the SAME code — it must submit again.
      rerender(<NamedPasscodeEntry onSubmit={onSubmit} error={null} />);
      typeCode('123456');
      flushTimers();
      expect(onSubmit).toHaveBeenCalledTimes(2);
      expect(onSubmit).toHaveBeenNthCalledWith(2, '123456');
    });

    it('does not clear the code when the error prop transitions to null', () => {
      const onSubmit = jest.fn();
      const { container, rerender } = renderComponent({ onSubmit });

      typeCode('12');
      rerender(<NamedPasscodeEntry onSubmit={onSubmit} error={null} />);
      expect(filledDotCount(container)).toBe(2);
    });
  });
});
