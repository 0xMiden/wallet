import React from 'react';

import { render, screen } from '@testing-library/react';

import AddressChip from './AddressChip';

// AddressChip is a thin composition over the canonical CopyChip: it wires an AddressShortView as
// its `children` and forwards `text`/`className`/`data-testid`, merging in its own neutral
// default className. CopyChip is stubbed to a prop-recording marker so every forwarded value is
// asserted precisely, without dragging in the clipboard hook stack (already covered by
// CopyChip.test.tsx — including the accessible-name-falls-back-to-content behavior the "no
// aria-label" test below depends on: this file can only prove AddressChip doesn't pass one, not
// that CopyChip then uses the content as the name, since the stub here renders `children` under a
// plain `<button>` regardless of what `aria-label` would have done).
const mockCopyChipProps = jest.fn();
const mockAddressShortViewProps = jest.fn();

jest.mock('components/ui/CopyChip', () => ({
  __esModule: true,
  CopyChip: (props: Record<string, unknown>) => {
    mockCopyChipProps(props);
    return <button data-testid="copy-chip">{props.children as React.ReactNode}</button>;
  }
}));

jest.mock('app/atoms/AddressShortView', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    mockAddressShortViewProps(props);
    return <span data-testid="address-short-view" />;
  }
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

const ADDRESS = '0xabcdef0123456789abcdef0123456789';

beforeEach(() => {
  mockCopyChipProps.mockClear();
  mockAddressShortViewProps.mockClear();
});

describe('AddressChip', () => {
  it('renders CopyChip with the address as its copy text, and AddressShortView as its content', () => {
    render(<AddressChip address={ADDRESS} />);

    expect(mockCopyChipProps).toHaveBeenCalledTimes(1);
    const chipProps = mockCopyChipProps.mock.calls[0][0];
    expect(chipProps.text).toBe(ADDRESS);
    expect(screen.getByTestId('copy-chip')).toBeInTheDocument();
    expect(screen.getByTestId('address-short-view')).toBeInTheDocument();

    const shortProps = mockAddressShortViewProps.mock.calls[0][0];
    expect(shortProps.address).toBe(ADDRESS);
    expect(shortProps.displayName).toBeUndefined();
    expect(shortProps.trim).toBeUndefined();
  });

  it('forwards displayName and trim to AddressShortView', () => {
    render(<AddressChip address={ADDRESS} displayName="Alice" trim={false} />);

    const shortProps = mockAddressShortViewProps.mock.calls[0][0];
    expect(shortProps.address).toBe(ADDRESS);
    expect(shortProps.displayName).toBe('Alice');
    expect(shortProps.trim).toBe(false);
  });

  it('merges the neutral default className with a min-w-0 shrink guard before the caller’s own className', () => {
    render(<AddressChip address={ADDRESS} className="ml-2" />);

    const chipProps = mockCopyChipProps.mock.calls[0][0];
    expect(chipProps.className).toContain('min-w-0');
    expect(chipProps.className).toContain('text-muted');
    expect(chipProps.className).toContain('ml-2');
  });

  it('forwards data-testid to CopyChip', () => {
    render(<AddressChip address={ADDRESS} data-testid="addr-chip" />);

    expect(mockCopyChipProps.mock.calls[0][0]['data-testid']).toBe('addr-chip');
  });

  it('passes no aria-label, so the visible value stays the accessible name', () => {
    // An `aria-label` REPLACES an element's accessible name, so passing one here would make a
    // screen reader hear "Copy to clipboard, button" instead of the address — and double the
    // "Copied" announcement against CopyChip's own `aria-live` region. See
    // CopyChip.test.tsx's `'falls back to the visible content as the accessible name when no
    // aria-label is given'` for proof the fallback actually produces the right name once this
    // component (correctly) supplies none.
    render(<AddressChip address={ADDRESS} />);

    expect(mockCopyChipProps.mock.calls[0][0]['aria-label']).toBeUndefined();
  });
});
