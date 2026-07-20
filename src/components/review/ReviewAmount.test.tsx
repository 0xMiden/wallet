import React from 'react';

import { render, screen } from '@testing-library/react';

import { ReviewAmount, ReviewAmountProps } from './ReviewAmount';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// react-i18next: return the key, but fold the interpolation `value` in so the
// ≈USD line's `t('approxFiatValue', { value })` is observable in the DOM.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { value?: string }) =>
      opts && opts.value !== undefined ? `${key}|${opts.value}` : key
  })
}));

// Replace the real TokenLogo (svg icon tree + Avatar) with a plain marker that
// echoes the exact props ReviewAmount wires up, so we can assert the resolved
// `symbol` (logoSymbol ?? symbol) and `size` precisely.
jest.mock('components/TokenLogo', () => ({
  TokenLogo: ({ symbol, size }: { symbol: string; size?: string }) => (
    <div data-testid="token-logo" data-symbol={symbol} data-size={size} />
  )
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeProps = (overrides: Partial<ReviewAmountProps> = {}): ReviewAmountProps => ({
  symbol: 'MIDEN',
  amount: '12.5',
  ...overrides
});

const renderAmount = (overrides: Partial<ReviewAmountProps> = {}) => render(<ReviewAmount {...makeProps(overrides)} />);

describe('ReviewAmount', () => {
  describe('amount + symbol', () => {
    it('renders "{amount} {symbol}"', () => {
      renderAmount({ amount: '12.5', symbol: 'MIDEN' });
      // Text is split by whitespace across the interpolation; match the node.
      expect(screen.getByText(/12\.5\s+MIDEN/)).toBeInTheDocument();
    });
  });

  describe('token logo', () => {
    it('renders the token logo at size "md"', () => {
      renderAmount();
      const logo = screen.getByTestId('token-logo');
      expect(logo).toBeInTheDocument();
      expect(logo).toHaveAttribute('data-size', 'md');
    });

    it('uses `symbol` for the logo when logoSymbol is omitted', () => {
      renderAmount({ symbol: 'ETH' });
      expect(screen.getByTestId('token-logo')).toHaveAttribute('data-symbol', 'ETH');
    });

    it('uses `logoSymbol` for the logo when provided (override)', () => {
      renderAmount({ symbol: 'PSWAP', logoSymbol: 'USDC' });
      expect(screen.getByTestId('token-logo')).toHaveAttribute('data-symbol', 'USDC');
      // The visible amount still uses the real symbol, not the logo override.
      expect(screen.getByText(/PSWAP/)).toBeInTheDocument();
    });
  });

  describe('label caption (optional)', () => {
    it('renders the label caption when provided', () => {
      renderAmount({ label: 'You Send' });
      expect(screen.getByText('You Send')).toBeInTheDocument();
    });

    it('omits the label caption when not provided', () => {
      renderAmount({ label: undefined });
      expect(screen.queryByText('You Send')).not.toBeInTheDocument();
    });

    it('omits the label caption when it is an empty string', () => {
      // Empty string is falsy, so the `label && (...)` branch is skipped.
      const { container } = renderAmount({ label: '' });
      expect(container.querySelector('.bg-surface-input')).not.toBeInTheDocument();
    });
  });

  describe('≈USD fiat line (optional)', () => {
    it('renders the fiat line, formatting to two decimals', () => {
      renderAmount({ fiat: 100.5 });
      // t('approxFiatValue', { value: '$100.50' }) -> "approxFiatValue|$100.50"
      expect(screen.getByText('approxFiatValue|$100.50')).toBeInTheDocument();
    });

    it('renders the fiat line when fiat is exactly 0 (0 != null is true)', () => {
      renderAmount({ fiat: 0 });
      expect(screen.getByText('approxFiatValue|$0.00')).toBeInTheDocument();
    });

    it('omits the fiat line when fiat is undefined', () => {
      renderAmount({ fiat: undefined });
      expect(screen.queryByText(/approxFiatValue/)).not.toBeInTheDocument();
    });
  });

  describe('composed hero (all optional fields present)', () => {
    it('renders label, logo override, amount/symbol and fiat together', () => {
      renderAmount({ symbol: 'BTC', amount: '0.01', fiat: 650, label: 'You Receive', logoSymbol: 'BTC' });
      expect(screen.getByText('You Receive')).toBeInTheDocument();
      expect(screen.getByTestId('token-logo')).toHaveAttribute('data-symbol', 'BTC');
      expect(screen.getByText(/0\.01\s+BTC/)).toBeInTheDocument();
      expect(screen.getByText('approxFiatValue|$650.00')).toBeInTheDocument();
    });
  });
});
