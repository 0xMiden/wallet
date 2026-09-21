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

beforeEach(() => {
  jest.clearAllMocks();
  mockWrite.mockResolvedValue(undefined);
});

afterEach(() => {
  jest.useRealTimers();
});

it('writes the given text to the clipboard on tap, with the tap haptic', async () => {
  render(<CopyButton text="0xabc123" data-testid="copy" />);

  await act(async () => {
    fireEvent.click(screen.getByTestId('copy'));
  });

  expect(mockWrite).toHaveBeenCalledWith({ string: '0xabc123' });
  expect(hapticLight).toHaveBeenCalledTimes(1);
});

it('uses the accent-tint-ink text token (there is no "accent" color)', () => {
  render(<CopyButton text="0xabc123" data-testid="copy" />);

  expect(screen.getByTestId('copy')).toHaveClass('text-accent-tint-ink');
  expect(screen.getByTestId('copy')).not.toHaveClass('text-accent');
});

it("lets a caller's className replace the default text color instead of losing to it", () => {
  // `cn` (tailwind-merge), not `clsx`: a caller that wants a different text color (e.g. a card
  // that paints its own foreground) passes it via `className`, and it must win over the default
  // `text-accent-tint-ink` rather than both classes landing in the string and the winner being
  // decided by Tailwind's compiled order (the same class of bug `Pill` had for border color).
  render(<CopyButton text="0xabc123" data-testid="copy" className="text-surface-balance-fg" />);

  const button = screen.getByTestId('copy');
  expect(button).toHaveClass('text-surface-balance-fg');
  expect(button).not.toHaveClass('text-accent-tint-ink');
});

it('wraps its label in an aria-live region, so "Copied" is announced', () => {
  render(<CopyButton text="0xabc123" data-testid="copy" />);

  const live = screen.getByTestId('copy').querySelector('[aria-live="polite"]');
  expect(live).toHaveTextContent('copy');
});

it('shows "Copy" by default, then "Copied" for a beat after a successful copy', async () => {
  render(<CopyButton text="0xabc123" />);

  expect(screen.getByText('copy')).toBeInTheDocument();

  await act(async () => {
    fireEvent.click(screen.getByRole('button'));
  });

  expect(screen.getByText('copied')).toBeInTheDocument();
  expect(screen.queryByText('copy')).not.toBeInTheDocument();
});

it('reverts to "Copy" after the feedback window elapses', async () => {
  jest.useFakeTimers();
  render(<CopyButton text="0xabc123" />);

  await act(async () => {
    fireEvent.click(screen.getByRole('button'));
  });
  expect(screen.getByText('copied')).toBeInTheDocument();

  act(() => {
    jest.advanceTimersByTime(1500);
  });

  expect(screen.getByText('copy')).toBeInTheDocument();
});

it('does not flip to "Copied" when the clipboard write rejects', async () => {
  mockWrite.mockRejectedValue(new Error('denied'));
  render(<CopyButton text="0xabc123" />);

  await act(async () => {
    fireEvent.click(screen.getByRole('button'));
  });

  expect(screen.getByText('copy')).toBeInTheDocument();
  expect(screen.queryByText('copied')).not.toBeInTheDocument();
});

it('lets a caller override the label with static children (e.g. an icon)', async () => {
  render(
    <CopyButton text="0xabc123">
      <svg data-testid="copy-icon" />
    </CopyButton>
  );

  expect(screen.getByTestId('copy-icon')).toBeInTheDocument();
  expect(screen.queryByText('copy')).not.toBeInTheDocument();
});

it('lets a caller swap content on the copied state via a render function', async () => {
  render(
    <CopyButton text="0xabc123">{copied => <span data-testid="icon">{copied ? 'check' : 'clip'}</span>}</CopyButton>
  );

  expect(screen.getByTestId('icon')).toHaveTextContent('clip');

  await act(async () => {
    fireEvent.click(screen.getByRole('button'));
  });

  expect(screen.getByTestId('icon')).toHaveTextContent('check');
});

it('forwards aria-label and stays disableable', () => {
  render(<CopyButton text="0xabc123" aria-label="copy the address" disabled />);

  const button = screen.getByRole('button', { name: 'copy the address' });
  expect(button).toBeDisabled();
});

it('lets a caller compute aria-label from the copied state (e.g. an icon-only button)', async () => {
  render(
    <CopyButton text="0xabc123" aria-label={copied => (copied ? 'copied the address' : 'copy the address')}>
      <svg data-testid="copy-icon" />
    </CopyButton>
  );

  expect(screen.getByRole('button', { name: 'copy the address' })).toBeInTheDocument();

  await act(async () => {
    fireEvent.click(screen.getByTestId('copy-icon'));
  });

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

  await act(async () => {
    fireEvent.click(screen.getByRole('button'));
  });
  expect(jest.getTimerCount()).toBe(1);

  unmount();
  // `not.toThrow()` was the whole assertion here before, and it held with the cleanup deleted —
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
