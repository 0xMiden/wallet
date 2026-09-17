import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { NetworkChip } from './NetworkChip';

jest.mock('app/icons/logos/eth.svg', () => ({ ReactComponent: () => <svg data-testid="eth-logo" /> }));
jest.mock('app/icons/v2', () => ({
  IconName: { MidenLogo: 'miden-logo' },
  Icon: ({ name }: { name: string }) => <svg data-testid={name} />
}));

describe('NetworkChip', () => {
  it('renders the Miden logo and label as static text without a handler', () => {
    render(<NetworkChip kind="miden" label="Miden" data-testid="chip" />);

    expect(screen.getByTestId('chip').tagName).toBe('SPAN');
    expect(screen.getByTestId('miden-logo')).toBeInTheDocument();
    expect(screen.getByText('Miden')).toBeInTheDocument();
  });

  it('renders a selectable Ethereum-family chip as a pressed button', () => {
    const onClick = jest.fn();
    render(<NetworkChip kind="ethereum" label="Sepolia" selected onClick={onClick} data-testid="chip" />);

    const chip = screen.getByTestId('chip');
    fireEvent.click(chip);

    expect(chip.tagName).toBe('BUTTON');
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(chip).toHaveClass('border-primary-500');
    expect(screen.getByTestId('eth-logo')).toBeInTheDocument();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
