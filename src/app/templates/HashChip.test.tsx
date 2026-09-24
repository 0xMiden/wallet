import React from 'react';

import { render, screen } from '@testing-library/react';

import HashChip from './HashChip';

// HashChip is a thin composition over the canonical CopyChip: it wires a HashShortView as its
// `children` and forwards `text`/`className`/`data-testid`, merging in its own neutral default
// className. CopyChip is stubbed to a prop-recording marker so every forwarded value is asserted
// precisely, without dragging in the clipboard hook stack (already covered by CopyChip.test.tsx —
// including the accessible-name-falls-back-to-content behavior the "no aria-label" test below
// depends on: this file can only prove HashChip doesn't pass one, not that CopyChip then uses the
// content as the name, since the stub here renders `children` under a plain `<div>` regardless of
// what `aria-label` would have done).
const mockCopyChipProps = jest.fn();
const mockHashShortViewProps = jest.fn();

jest.mock('components/ui/CopyChip', () => ({
  __esModule: true,
  CopyChip: (props: Record<string, unknown>) => {
    mockCopyChipProps(props);
    return <div data-testid="copy-chip">{props.children as React.ReactNode}</div>;
  }
}));

jest.mock('app/atoms/HashShortView', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    mockHashShortViewProps(props);
    return <span data-testid="hash-short-view" />;
  }
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

describe('HashChip', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders CopyChip with the hash as its copy text, and HashShortView as its content', () => {
    const hash = '0xabcdef0123456789';
    render(<HashChip hash={hash} />);

    const chipProps = mockCopyChipProps.mock.calls[0][0];
    expect(chipProps.text).toBe(hash);
    expect(screen.getByTestId('copy-chip')).toBeInTheDocument();
    expect(screen.getByTestId('hash-short-view')).toBeInTheDocument();

    // Every trimming prop is undefined by default.
    expect(mockHashShortViewProps.mock.calls[0][0]).toEqual({
      hash,
      trimHash: undefined,
      trimAfter: undefined,
      firstCharsCount: undefined,
      lastCharsCount: undefined,
      displayName: undefined
    });
  });

  it('forwards every trim prop and displayName to HashShortView', () => {
    render(
      <HashChip
        hash="hashy"
        trimHash={false}
        trimAfter={10}
        firstCharsCount={2}
        lastCharsCount={3}
        displayName="My Wallet"
      />
    );

    expect(mockHashShortViewProps.mock.calls[0][0]).toEqual({
      hash: 'hashy',
      trimHash: false,
      trimAfter: 10,
      firstCharsCount: 2,
      lastCharsCount: 3,
      displayName: 'My Wallet'
    });
  });

  it("merges the neutral default className with a min-w-0 shrink guard before the caller's own className", () => {
    // Mirrors SwapDetail's real usage: its own font/color classes must land alongside (and, being
    // last in `cn`, win any conflict with) the neutral default.
    render(<HashChip hash="hashy" className="font-heading text-base font-semibold" />);

    const chipProps = mockCopyChipProps.mock.calls[0][0];
    expect(chipProps.className).toContain('min-w-0');
    expect(chipProps.className).toContain('font-semibold');
    expect(chipProps.className).not.toContain('font-normal');
  });

  it('forwards data-testid to CopyChip', () => {
    render(<HashChip hash="hashy" data-testid="hash-chip-el" />);

    expect(mockCopyChipProps.mock.calls[0][0]['data-testid']).toBe('hash-chip-el');
  });

  it('passes no aria-label, so the visible value stays the accessible name', () => {
    // An `aria-label` REPLACES an element's accessible name, so passing one here would make a
    // screen reader hear "Copy to clipboard, button" instead of the hash — and double the
    // "Copied" announcement against CopyChip's own `aria-live` region. See
    // CopyChip.test.tsx's `'falls back to the visible content as the accessible name when no
    // aria-label is given'` for proof the fallback actually produces the right name once this
    // component (correctly) supplies none.
    render(<HashChip hash="hashy" />);

    expect(mockCopyChipProps.mock.calls[0][0]['aria-label']).toBeUndefined();
  });
});
