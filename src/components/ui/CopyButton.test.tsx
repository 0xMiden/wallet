import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

import { CopyButton } from './CopyButton';

const mockWrite = jest.fn();
jest.mock('@capacitor/clipboard', () => ({ Clipboard: { write: (...args: unknown[]) => mockWrite(...args) } }));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));

const mockMotion = { reduce: false };
jest.mock('framer-motion', () => ({
  ...jest.requireActual('framer-motion'),
  useReducedMotion: () => mockMotion.reduce
}));

/** The label that has settled in (not the one rolling out). */
const presentLabel = (root: HTMLElement) => root.querySelector('[data-copy-label] [data-present="true"]');
/** The glyph that has settled in (not the one morphing out). */
const presentGlyph = (root: HTMLElement) => root.querySelector('[data-copy-icon] [data-present="true"]');

const tap = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  mockMotion.reduce = false;
  mockWrite.mockResolvedValue(undefined);
});

afterEach(() => {
  jest.useRealTimers();
});

it('writes the given text to the clipboard on tap, with exactly one tap haptic', async () => {
  render(<CopyButton text="0xabc123" data-testid="copy" />);

  await tap(screen.getByTestId('copy'));

  expect(mockWrite).toHaveBeenCalledWith({ string: '0xabc123' });
  expect(hapticLight).toHaveBeenCalledTimes(1);
});

it('uses the accent-tint-ink text token (there is no "accent" color)', () => {
  render(<CopyButton text="0xabc123" data-testid="copy" />);

  expect(screen.getByTestId('copy')).toHaveClass('text-accent-tint-ink');
  expect(screen.getByTestId('copy')).not.toHaveClass('text-accent');
});

it("lets a caller's className replace the default text color instead of losing to it", () => {
  render(<CopyButton text="0xabc123" data-testid="copy" className="text-surface-balance-fg" />);

  const button = screen.getByTestId('copy');
  expect(button).toHaveClass('text-surface-balance-fg');
  expect(button).not.toHaveClass('text-accent-tint-ink');
});

it('keeps its content in an aria-live region, so "Copied" is announced', () => {
  render(<CopyButton text="0xabc123" data-testid="copy" />);

  const live = screen.getByTestId('copy').querySelector('[aria-live="polite"]');
  expect(live).toHaveTextContent('copy');
});

describe('the text action', () => {
  it('rolls its label from "Copy" to "Copied" after a copy, then back after the feedback window', async () => {
    jest.useFakeTimers();
    render(<CopyButton text="0xabc123" data-testid="copy" />);
    const button = screen.getByTestId('copy');
    expect(presentLabel(button)).toHaveTextContent(/^copy$/);

    await tap(button);
    expect(presentLabel(button)).toHaveTextContent('copied');
    expect(presentLabel(button)).toHaveAttribute('data-copy-state', 'copied');
    expect(button).toHaveAttribute('data-copied', 'true');

    act(() => {
      jest.advanceTimersByTime(1500);
    });
    expect(presentLabel(button)).toHaveTextContent(/^copy$/);
    expect(button).toHaveAttribute('data-copied', 'false');
  });

  it('hides the label that rolls out from assistive tech', async () => {
    // Fake timers so the exit animation cannot advance while this asserts on it. The leaving slot
    // exists only mid-roll, and on real timers a slow enough machine finishes the roll inside the
    // `act` flush below, leaving nothing to query. `afterEach` restores real timers.
    jest.useFakeTimers();
    render(<CopyButton text="0xabc123" data-testid="copy" />);
    const button = screen.getByTestId('copy');

    await tap(button);

    // Still rolling out right after the tap, and not read while it does.
    const leaving = button.querySelector('[data-copy-label] [data-present="false"]');
    expect(leaving).toHaveTextContent(/^copy$/);
    expect(leaving).toHaveAttribute('aria-hidden', 'true');
  });

  it('has no glyph unless asked for one', () => {
    render(<CopyButton text="0xabc123" data-testid="copy" />);
    expect(screen.getByTestId('copy').querySelector('[data-copy-icon]')).toBeNull();
  });
});

describe('the glyph', () => {
  it('morphs the copy mark into a check after a copy, and back after the feedback window', async () => {
    jest.useFakeTimers();
    render(<CopyButton text="0xabc123" data-testid="copy" icon="only" aria-label="copy the address" />);
    const button = screen.getByTestId('copy');
    expect(presentGlyph(button)).toHaveAttribute('data-copy-state', 'idle');

    await tap(button);
    expect(presentGlyph(button)).toHaveAttribute('data-copy-state', 'copied');

    act(() => {
      jest.advanceTimersByTime(1500);
    });
    expect(presentGlyph(button)).toHaveAttribute('data-copy-state', 'idle');
  });

  it('sits before or after the label', () => {
    const { rerender } = render(<CopyButton text="0xabc" data-testid="copy" icon="leading" label="addr" />);
    let row = screen.getByTestId('copy').querySelector('[aria-live]')!;
    expect(row.firstElementChild).toHaveAttribute('data-copy-icon');

    rerender(<CopyButton text="0xabc" data-testid="copy" icon="trailing" label="addr" />);
    row = screen.getByTestId('copy').querySelector('[aria-live]')!;
    expect(row.children[1]).toHaveAttribute('data-copy-icon');
  });

  it('keeps a value label in place with copiedLabel={null}, and still announces "Copied"', async () => {
    render(<CopyButton text="0xabc" data-testid="copy" icon="trailing" label="0xab…c" copiedLabel={null} />);
    const button = screen.getByTestId('copy');

    await tap(button);

    expect(presentLabel(button)).toHaveTextContent('0xab…c');
    expect(presentGlyph(button)).toHaveAttribute('data-copy-state', 'copied');
    expect(button.querySelector('[aria-live] .sr-only')).toHaveTextContent('copied');
  });
});

describe('reduced motion', () => {
  it('swaps instantly: no presence animation, no blur, no rotation', async () => {
    mockMotion.reduce = true;
    render(<CopyButton text="0xabc" data-testid="copy" icon="leading" />);
    const button = screen.getByTestId('copy');

    await tap(button);

    // Exactly one glyph and one label: nothing is left animating out.
    expect(button.querySelectorAll('[data-copy-icon] [data-copy-state]')).toHaveLength(1);
    expect(button.querySelectorAll('[data-copy-label] [data-copy-state]')).toHaveLength(1);
    expect(presentGlyph(button)).toHaveAttribute('data-copy-state', 'copied');
    expect(presentLabel(button)).toHaveTextContent('copied');
    for (const el of Array.from(button.querySelectorAll<HTMLElement>('[data-copy-state]'))) {
      expect(el.style.filter).toBe('');
      expect(el.style.transform).toBe('');
    }
  });
});

it('shows no success when the clipboard write rejects', async () => {
  mockWrite.mockRejectedValue(new Error('denied'));
  render(<CopyButton text="0xabc123" data-testid="copy" icon="leading" />);
  const button = screen.getByTestId('copy');

  await tap(button);

  expect(presentLabel(button)).toHaveTextContent(/^copy$/);
  expect(presentGlyph(button)).toHaveAttribute('data-copy-state', 'idle');
  expect(button).toHaveAttribute('data-copied', 'false');
  expect(button.querySelector('[data-copy-state="copied"]')).toBeNull();
});

it('forwards aria-label and stays disableable', () => {
  render(<CopyButton text="0xabc123" aria-label="copy the address" disabled />);

  const button = screen.getByRole('button', { name: 'copy the address' });
  expect(button).toBeDisabled();
});

it('lets a caller compute aria-label from the copied state (e.g. an icon-only button)', async () => {
  render(
    <CopyButton
      text="0xabc123"
      icon="only"
      aria-label={copied => (copied ? 'copied the address' : 'copy the address')}
    />
  );

  expect(screen.getByRole('button', { name: 'copy the address' })).toBeInTheDocument();

  await tap(screen.getByRole('button'));

  expect(screen.getByRole('button', { name: 'copied the address' })).toBeInTheDocument();
});

it('does not write to the clipboard while disabled', async () => {
  render(<CopyButton text="0xabc123" disabled />);

  fireEvent.click(screen.getByRole('button'));

  expect(mockWrite).not.toHaveBeenCalled();
});

it('clears its feedback timer on unmount', async () => {
  jest.useFakeTimers();
  const { unmount } = render(<CopyButton text="0xabc123" />);

  await tap(screen.getByRole('button'));
  expect(jest.getTimerCount()).toBe(1);

  unmount();
  // `not.toThrow()` was the whole assertion here before, and it held with the cleanup deleted -
  // React 18 no-ops a setState after unmount, so nothing ever threw. Count the timer instead.
  expect(jest.getTimerCount()).toBe(0);
});

it('arms no timer when it is unmounted while the clipboard write is still pending', async () => {
  jest.useFakeTimers();
  let resolveWrite: () => void = () => undefined;
  mockWrite.mockReturnValueOnce(
    new Promise<void>(resolve => {
      resolveWrite = resolve;
    })
  );
  const { unmount } = render(<CopyButton text="0xabc123" />);

  fireEvent.click(screen.getByRole('button'));
  unmount();

  // The timer is armed only after the awaited write, so at unmount there is nothing to clear and
  // the cleanup cannot help. The continuation has to check liveness itself.
  await act(async () => {
    resolveWrite();
  });
  expect(jest.getTimerCount()).toBe(0);
});
