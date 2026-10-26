import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { NetworkChip } from 'components/NetworkChip';

describe('NetworkChip', () => {
  it('renders the Miden logo and label as static text without a handler', () => {
    render(<NetworkChip kind="miden" label="Miden" data-testid="chip" />);

    expect(screen.getByTestId('chip').tagName).toBe('SPAN');
    // The Miden mark sits bare; only the Ethereum glyph gets a brand-blue disc.
    expect(screen.getByTestId('chip').querySelector('.bg-\\[\\#627EEA\\]')).toBeNull();
    expect(screen.getByText('Miden')).toBeInTheDocument();
  });

  it('renders a selectable Ethereum-family chip as a pressed button', () => {
    const onClick = jest.fn();
    render(<NetworkChip kind="ethereum" label="Sepolia" selected onClick={onClick} data-testid="chip" />);

    const chip = screen.getByTestId('chip');
    fireEvent.click(chip);

    expect(chip.tagName).toBe('BUTTON');
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(chip).toHaveClass('rounded-xl', 'bg-fill-pressed', 'min-h-11');
    expect(chip).not.toHaveClass('bg-network-ethereum-tint');
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

it('uses one neutral network tag treatment for both network families', () => {
  const { rerender } = render(<NetworkChip kind="miden" label="Miden" data-testid="chip" />);
  expect(screen.getByTestId('chip')).toHaveClass('bg-fill', 'text-ink', 'rounded-xl', 'border-transparent');
  rerender(<NetworkChip kind="ethereum" label="Sepolia" data-testid="chip" />);
  expect(screen.getByTestId('chip')).toHaveClass('bg-fill', 'text-ink', 'rounded-xl', 'border-transparent');
});
