import React from 'react';

import { render, screen } from '@testing-library/react';

import { TokenAmount, UsdAmount } from './TokenAmount';

describe('shared amount components', () => {
  it('formats bridge amounts and retains the exact value in the title', () => {
    render(<TokenAmount amount="1.5747999999999986" symbol="NEAR" data-testid="amount" />);
    expect(screen.getByTestId('amount')).toHaveTextContent('1.57 NEAR');
    expect(screen.getByTestId('amount')).toHaveAttribute('title', '1.5747999999999986 NEAR');
    expect(screen.getByTestId('amount')).toHaveClass('min-w-0', '[overflow-wrap:anywhere]');
  });

  it('preserves the caller styles for the value and symbol', () => {
    render(
      <TokenAmount
        amount={1234567890123456789n}
        decimals={18}
        symbol="ETH"
        className="text-value text-ink"
        symbolClassName="text-muted"
        data-testid="amount"
      />
    );
    expect(screen.getByTestId('amount')).toHaveTextContent('1.234568 ETH');
    expect(screen.getByTestId('amount')).toHaveClass('text-value', 'text-ink');
    expect(screen.getByText('ETH')).toHaveClass('text-muted');
  });

  it('applies exact formatting and explicit rounding', () => {
    const { rerender } = render(<TokenAmount amount="1.234" rounding="up" />);
    expect(screen.getByText('1.24')).toBeInTheDocument();
    rerender(<TokenAmount amount="1.234" formatting="exact" rounding="down" title="Exact" />);
    expect(screen.getByText('1.234')).toHaveAttribute('title', 'Exact');
  });

  it('supports animated USD values and translation text', () => {
    const { rerender } = render(<UsdAmount amount={1234.5} animated renderText={text => `≈ ${text}`} />);
    expect(screen.getByText('≈ $1,234.50')).toBeInTheDocument();
    rerender(<UsdAmount amount={2345.6} animated renderText={text => `≈ ${text}`} />);
    expect(screen.getByText('≈ $2,345.60')).toBeInTheDocument();
  });

  it('does not convert bigint amounts to numbers for animation', () => {
    render(<TokenAmount amount={9007199254740993n} decimals={0} animated />);
    expect(screen.getByText('9007199254740993')).toBeInTheDocument();
  });

  it('shows a placeholder while the amount is absent', () => {
    const { rerender } = render(<TokenAmount amount={null} placeholder="Loading" />);
    expect(screen.getByText('Loading')).toBeInTheDocument();
    rerender(<UsdAmount amount={undefined} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
