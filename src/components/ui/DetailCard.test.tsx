import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { DetailCard, DetailRow } from './DetailCard';

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));

describe('DetailCard', () => {
  it('renders a fill card with 16px radius and hairline dividers between rows', () => {
    const { container } = render(
      <DetailCard>
        <DetailRow label="A">1</DetailRow>
        <DetailRow label="B">2</DetailRow>
      </DetailCard>
    );

    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper).toHaveClass('bg-fill', 'rounded-2xl', 'divide-y', 'divide-hairline');
  });

  it('forwards a caller className for margin/layout', () => {
    const { container } = render(<DetailCard className="mt-6">child</DetailCard>);
    expect(container.firstChild as HTMLElement).toHaveClass('mt-6');
  });
});

describe('DetailRow', () => {
  it('renders the muted label and the ink value', () => {
    render(<DetailRow label="Network">Miden</DetailRow>);

    const label = screen.getByText('Network');
    expect(label).toHaveClass('text-muted', 'text-sm');

    const value = screen.getByText('Miden');
    expect(value).toHaveClass('text-ink', 'text-[15px]', 'font-bold');
  });

  it('lays the value out beside the label by default, right-aligned', () => {
    const { container } = render(<DetailRow label="Network">Miden</DetailRow>);
    const row = container.firstChild as HTMLElement;
    expect(row).toHaveClass('items-start');
    expect(row).not.toHaveClass('flex-col');
  });

  it('stacks the value under the label when stacked is set, for a full address', () => {
    const { container } = render(
      <DetailRow label="To" stacked>
        0xabc...def
      </DetailRow>
    );
    const row = container.firstChild as HTMLElement;
    expect(row).toHaveClass('flex-col');
    expect(screen.getByText('0xabc...def')).toBeInTheDocument();
  });

  it('renders a sub line under the value when provided', () => {
    render(
      <DetailRow label="Network fee" sub="Estimated, reserved from Available">
        0.001 MDN
      </DetailRow>
    );
    expect(screen.getByText('Estimated, reserved from Available')).toHaveClass('text-muted');
  });

  it('renders no action when none is provided', () => {
    render(<DetailRow label="Network">Miden</DetailRow>);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders an orange text action and fires its handler with a haptic', () => {
    const onClick = jest.fn();
    render(
      <DetailRow label="Address" action={{ label: 'Copy', onClick }}>
        0xabc...def
      </DetailRow>
    );

    const action = screen.getByRole('button', { name: 'Copy' });
    expect(action).toHaveClass('text-accent-primary');

    fireEvent.click(action);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('forwards data-testid to the row root', () => {
    render(
      <DetailRow label="Address" data-testid="detail-address">
        0xabc
      </DetailRow>
    );
    expect(screen.getByTestId('detail-address')).toBeInTheDocument();
  });
});
