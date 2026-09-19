import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

import { CopyChip } from './CopyChip';

const mockWrite = jest.fn();
jest.mock('@capacitor/clipboard', () => ({ Clipboard: { write: (...args: unknown[]) => mockWrite(...args) } }));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticSelection: jest.fn() }));

jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid="glyph" data-name={name} />,
  IconName: { CopyNew: 'copy-new', Checkmark: 'checkmark' }
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockWrite.mockResolvedValue(undefined);
});

afterEach(() => {
  jest.useRealTimers();
});

it('renders as a Pill (rounded, tappable) showing the given content', () => {
  render(
    <CopyChip text="0xabc123" data-testid="chip">
      0xab…c123
    </CopyChip>
  );

  const chip = screen.getByTestId('chip');
  expect(chip.tagName).toBe('BUTTON');
  expect(chip).toHaveClass('rounded-full');
  expect(chip).toHaveTextContent('0xab…c123');
});

it('carries the untrimmed text in a hidden sibling input, not nested inside the Pill button', () => {
  // `<input>` is not valid content inside a `<button>`, so this has to be a sibling — and it has
  // to exist at all, because it is how the wallet's E2E suite reads a full address/hash a chip
  // only ever shows trimmed (`playwright/e2e/helpers/history.ts`'s `readDetailRowFullValue`).
  const { container } = render(
    <CopyChip text="0xabcdef0123456789" data-testid="chip">
      0xab…6789
    </CopyChip>
  );

  const input = container.querySelector('input') as HTMLInputElement;
  expect(input).toBeInTheDocument();
  expect(input.value).toBe('0xabcdef0123456789');
  expect(screen.getByTestId('chip').contains(input)).toBe(false);
});

it('writes the given text to the clipboard on tap, with the Pill tap haptic (not a second one)', async () => {
  render(
    <CopyChip text="0xabc123" data-testid="chip">
      0xab…c123
    </CopyChip>
  );

  await act(async () => {
    fireEvent.click(screen.getByTestId('chip'));
  });

  expect(mockWrite).toHaveBeenCalledWith({ string: '0xabc123' });
  // Pill's own onClick wrapper fires the haptic; useClipboardCopy must not fire a second one.
  expect(hapticLight).toHaveBeenCalledTimes(1);
});

const presentGlyph = () => screen.getByTestId('chip').querySelector('[data-copy-icon] [data-present="true"]');

it('leads with the shared animated copy glyph, which morphs to a check after a copy and back', async () => {
  jest.useFakeTimers();
  render(
    <CopyChip text="0xabc123" data-testid="chip">
      0xab…c123
    </CopyChip>
  );

  expect(presentGlyph()).toHaveAttribute('data-copy-state', 'idle');
  expect(presentGlyph()?.querySelector('[data-name="copy-new"]')).toBeInTheDocument();

  await act(async () => {
    fireEvent.click(screen.getByTestId('chip'));
  });
  expect(presentGlyph()).toHaveAttribute('data-copy-state', 'copied');
  expect(presentGlyph()?.querySelector('[data-name="checkmark"]')).toBeInTheDocument();

  act(() => {
    jest.advanceTimersByTime(1500);
  });
  expect(presentGlyph()).toHaveAttribute('data-copy-state', 'idle');
});

it('shows no check when the clipboard write rejects', async () => {
  mockWrite.mockRejectedValue(new Error('denied'));
  render(
    <CopyChip text="0xabc123" data-testid="chip">
      0xab…c123
    </CopyChip>
  );

  await act(async () => {
    fireEvent.click(screen.getByTestId('chip'));
  });

  expect(presentGlyph()).toHaveAttribute('data-copy-state', 'idle');
  expect(screen.getByTestId('chip').querySelector('[data-copy-state="copied"]')).toBeNull();
});

it('announces "Copied" for screen readers without moving focus', async () => {
  render(
    <CopyChip text="0xabc123" data-testid="chip">
      0xab…c123
    </CopyChip>
  );

  const live = screen.getByTestId('chip').querySelector('[aria-live="polite"]');
  expect(live).toHaveTextContent('');

  await act(async () => {
    fireEvent.click(screen.getByTestId('chip'));
  });

  expect(live).toHaveTextContent('copied');
});

it('does not flip to the checkmark when the clipboard write rejects', async () => {
  mockWrite.mockRejectedValue(new Error('denied'));
  render(
    <CopyChip text="0xabc123" data-testid="chip">
      0xab…c123
    </CopyChip>
  );

  await act(async () => {
    fireEvent.click(screen.getByTestId('chip'));
  });

  expect(screen.getByTestId('chip').querySelector('[data-name="checkmark"]')).not.toBeInTheDocument();
});

it('falls back to the visible content as the accessible name when no aria-label is given', () => {
  // `AddressChip`/`HashChip` (the only real callers) pass no `aria-label` — the trimmed
  // address/hash they render as `children` IS the chip's accessible name. An `aria-label` would
  // replace it, so a screen reader would hear "Copy to clipboard, button" instead of the value.
  render(<CopyChip text="0xabc123">0xab…c123</CopyChip>);

  expect(screen.getByRole('button', { name: '0xab…c123' })).toBeInTheDocument();
});

it('forwards a static aria-label', () => {
  render(
    <CopyChip text="0xabc123" aria-label="copy the address">
      0xab…c123
    </CopyChip>
  );

  expect(screen.getByRole('button', { name: 'copy the address' })).toBeInTheDocument();
});

it('lets a caller compute aria-label from the copied state (e.g. "Copy" vs "Copied.")', async () => {
  render(
    <CopyChip text="0xabc123" aria-label={copied => (copied ? 'copied the hash' : 'copy the hash')}>
      0xab…c123
    </CopyChip>
  );

  expect(screen.getByRole('button', { name: 'copy the hash' })).toBeInTheDocument();

  await act(async () => {
    fireEvent.click(screen.getByRole('button'));
  });

  expect(screen.getByRole('button', { name: 'copied the hash' })).toBeInTheDocument();
});
