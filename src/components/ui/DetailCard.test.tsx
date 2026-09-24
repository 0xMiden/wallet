import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

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
    // Inter, not the ancestor's Nunito: `DetailSection` (history) wraps its
    // cards in `font-heading`, and the label must stay Inter under it.
    expect(label).toHaveClass('text-body-sm', 'text-muted');

    const value = screen.getByText('Miden');
    expect(value).toHaveClass('text-value', 'text-ink');
  });

  it('does not break an unstacked value, which is always short', () => {
    render(<DetailRow label="Network">Miden</DetailRow>);
    expect(screen.getByText('Miden')).not.toHaveClass('break-all');
  });

  it('breaks a stacked value, for a full address that must wrap instead of overflow', () => {
    render(
      <DetailRow label="To" stacked>
        0xabc...def
      </DetailRow>
    );
    expect(screen.getByText('0xabc...def')).toHaveClass('break-all');
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

  it('renders an info hint beside the label, inside the label line', () => {
    render(
      <DetailRow label="Rate" info={<button data-testid="rate-info">i</button>}>
        1 ETH
      </DetailRow>
    );
    const label = screen.getByText('Rate');
    expect(label).toContainElement(screen.getByTestId('rate-info'));
  });

  it('renders no hint when none is provided', () => {
    render(<DetailRow label="Rate">1 ETH</DetailRow>);
    expect(screen.getByText('Rate').children).toHaveLength(0);
  });

  it('renders no action when none is provided', () => {
    render(<DetailRow label="Network">Miden</DetailRow>);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders a text action at 4.5:1 on fill and fires its handler with a haptic', () => {
    const onClick = jest.fn();
    render(
      <DetailRow label="Address" action={{ label: 'Copy', onClick }}>
        0xabc...def
      </DetailRow>
    );

    const action = screen.getByRole('button', { name: 'Copy' });
    // `text-accent-primary` is 2.64:1 on `fill` — under AA. `accent-tint-ink` is
    // the accent pair that actually clears 4.5:1 there (5.05:1 light, 7.69:1 dark).
    expect(action).toHaveClass('text-accent-tint-ink');
    expect(action).not.toHaveClass('text-accent-primary');

    fireEvent.click(action);
    expect(hapticLight).toHaveBeenCalledTimes(1);
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

  it('forwards a caller className to the row root for layout', () => {
    const { container } = render(
      <DetailRow label="Address" className="mt-2">
        0xabc
      </DetailRow>
    );
    expect(container.firstChild).toHaveClass('mt-2');
  });
});
