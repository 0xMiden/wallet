import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

// Import EVERY value export through the barrel under test so `index.ts`'s
// re-export lines are executed and counted. Type-only exports are erased by the
// compiler, so exercising the runtime exports fully covers the barrel.
import { ReviewAmount, ReviewLabel, ReviewLayout, ReviewRow } from './index';
import type { ReviewAction, ReviewAmountProps, ReviewLayoutProps, ReviewRowProps } from './index';

const h = React.createElement;

// ---------------------------------------------------------------------------
// Module mocks (mirrors the sibling ReviewLayout / ReviewAmount test setups)
// ---------------------------------------------------------------------------

// Hide-navbar hook: assert it's invoked, keep it a no-op so it doesn't mutate
// document.body across tests. `mock`-prefixed so it's safe inside the factory.
const mockUseHideNavbar = jest.fn();
jest.mock('lib/mobile/useHideNavbarWhileOpen', () => ({
  useHideNavbarWhileOpen: (...a: any[]) => mockUseHideNavbar(...a)
}));

// Replace the real Button (framer-motion / haptics / icon tree) with a plain
// <button> that forwards exactly the props ReviewLayout wires up, so we can
// assert type / variant / data-testid / onClick precisely. `require('react')`
// inside the factory avoids any hoisting/out-of-scope reference concerns.
jest.mock('components/Button', () => {
  const Rc = require('react');
  return {
    ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost' },
    Button: ({ title, onClick, type, variant, className, ...props }: any) =>
      Rc.createElement(
        'button',
        {
          type,
          onClick,
          'data-variant': variant,
          'data-testid': props['data-testid'],
          className
        },
        title
      )
  };
});

// Replace the real TokenLogo (svg icon tree + Avatar) with a plain marker that
// echoes the props ReviewAmount wires up, so we can assert the resolved
// `symbol` (logoSymbol ?? symbol) and `size` precisely.
jest.mock('components/TokenLogo', () => {
  const Rc = require('react');
  return {
    TokenLogo: ({ symbol, size }: { symbol: string; size?: string }) =>
      Rc.createElement('div', { 'data-testid': 'token-logo', 'data-symbol': symbol, 'data-size': size })
  };
});

// react-i18next: return the key, but fold the interpolation `value` in so the
// ≈USD line's `t('approxFiatValue', { value })` is observable in the DOM.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { value?: string }) => (opts && opts.value !== undefined ? `${key}|${opts.value}` : key)
  })
}));

// ---------------------------------------------------------------------------
// Barrel wiring — the export identity is what index.ts is responsible for.
// ---------------------------------------------------------------------------

describe('components/review barrel (index.ts)', () => {
  it('re-exports all four review components as callable functions', () => {
    expect(typeof ReviewLayout).toBe('function');
    expect(typeof ReviewRow).toBe('function');
    expect(typeof ReviewLabel).toBe('function');
    expect(typeof ReviewAmount).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// ReviewLabel
// ---------------------------------------------------------------------------

describe('ReviewLabel (via barrel)', () => {
  it('renders its children inside a pill span', () => {
    render(h(ReviewLabel, null, 'Recipient'));
    expect(screen.getByText('Recipient')).toBeInTheDocument();
  });

  it('merges an extra className onto the base pill classes', () => {
    const { container } = render(h(ReviewLabel, { className: 'extra-pill', children: 'Amount' }));
    const span = container.querySelector('span');
    expect(span).toHaveClass('extra-pill');
    expect(span).toHaveClass('rounded-full');
  });

  it('renders without a className prop (undefined branch)', () => {
    const { container } = render(h(ReviewLabel, null, 'Fee'));
    // clsx drops the undefined arg; base classes still present.
    expect(container.querySelector('span')).toHaveClass('bg-surface-interactive');
  });
});

// ---------------------------------------------------------------------------
// ReviewRow
// ---------------------------------------------------------------------------

const makeRowProps = (overrides: Partial<ReviewRowProps> = {}): ReviewRowProps => ({
  label: 'To',
  value: '0xabc…def',
  ...overrides
});

describe('ReviewRow (via barrel)', () => {
  it('renders the label pill and the default value text', () => {
    render(h(ReviewRow, makeRowProps()));
    expect(screen.getByText('To')).toBeInTheDocument();
    expect(screen.getByText('0xabc…def')).toBeInTheDocument();
  });

  it('renders custom children in place of value (children ?? value)', () => {
    render(h(ReviewRow, makeRowProps({ value: 'ignored' }), h('span', { 'data-testid': 'custom' }, 'CUSTOM')));
    expect(screen.getByTestId('custom')).toHaveTextContent('CUSTOM');
    expect(screen.queryByText('ignored')).not.toBeInTheDocument();
  });

  it('renders an inline Edit button and fires onEdit when clicked', () => {
    const onEdit = jest.fn();
    render(h(ReviewRow, makeRowProps({ onEdit, editLabel: 'Edit' })));
    const editBtn = screen.getByRole('button', { name: 'Edit' });
    expect(editBtn).toBeInTheDocument();
    fireEvent.click(editBtn);
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('does not render an Edit button when onEdit is omitted', () => {
    render(h(ReviewRow, makeRowProps()));
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders the info note when provided', () => {
    const { container } = render(h(ReviewRow, makeRowProps({ note: 'Network fee estimate' })));
    expect(screen.getByText('Network fee estimate')).toBeInTheDocument();
    // The mocked information.svg renders as a plain <svg> element.
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('omits the info note (and its icon) when note is not provided', () => {
    const { container } = render(h(ReviewRow, makeRowProps()));
    expect(container.querySelector('svg')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// ReviewAmount
// ---------------------------------------------------------------------------

const makeAmountProps = (overrides: Partial<ReviewAmountProps> = {}): ReviewAmountProps => ({
  symbol: 'MIDEN',
  amount: '12.5',
  ...overrides
});

describe('ReviewAmount (via barrel)', () => {
  it('renders "{amount} {symbol}"', () => {
    render(h(ReviewAmount, makeAmountProps({ amount: '12.5', symbol: 'MIDEN' })));
    expect(screen.getByText(/12\.5\s+MIDEN/)).toBeInTheDocument();
  });

  it('renders the token logo at size "md", falling back to `symbol`', () => {
    render(h(ReviewAmount, makeAmountProps({ symbol: 'ETH' })));
    const logo = screen.getByTestId('token-logo');
    expect(logo).toHaveAttribute('data-size', 'md');
    expect(logo).toHaveAttribute('data-symbol', 'ETH');
  });

  it('uses `logoSymbol` for the logo when provided (override)', () => {
    render(h(ReviewAmount, makeAmountProps({ symbol: 'PSWAP', logoSymbol: 'USDC' })));
    expect(screen.getByTestId('token-logo')).toHaveAttribute('data-symbol', 'USDC');
    expect(screen.getByText(/PSWAP/)).toBeInTheDocument();
  });

  it('renders the label caption when provided', () => {
    render(h(ReviewAmount, makeAmountProps({ label: 'You Send' })));
    expect(screen.getByText('You Send')).toBeInTheDocument();
  });

  it('omits the label caption when not provided', () => {
    render(h(ReviewAmount, makeAmountProps({ label: undefined })));
    expect(screen.queryByText('You Send')).not.toBeInTheDocument();
  });

  it('renders the ≈USD fiat line formatted to two decimals', () => {
    render(h(ReviewAmount, makeAmountProps({ fiat: 100.5 })));
    expect(screen.getByText('approxFiatValue|$100.50')).toBeInTheDocument();
  });

  it('renders the fiat line when fiat is exactly 0 (0 != null)', () => {
    render(h(ReviewAmount, makeAmountProps({ fiat: 0 })));
    expect(screen.getByText('approxFiatValue|$0.00')).toBeInTheDocument();
  });

  it('omits the fiat line when fiat is undefined', () => {
    render(h(ReviewAmount, makeAmountProps({ fiat: undefined })));
    expect(screen.queryByText(/approxFiatValue/)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// ReviewLayout
// ---------------------------------------------------------------------------

const hero = h('div', { 'data-testid': 'hero' }, 'HERO');
const rowChild = h('div', { 'data-testid': 'child' }, 'ROW');

const makeLayoutProps = (overrides: Partial<ReviewLayoutProps> = {}): ReviewLayoutProps => ({
  hero,
  children: rowChild,
  primary: { label: 'Confirm', onPress: jest.fn() } as ReviewAction,
  ...overrides
});

describe('ReviewLayout (via barrel)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('hides the bottom navbar while mounted', () => {
    render(h(ReviewLayout, makeLayoutProps()));
    expect(mockUseHideNavbar).toHaveBeenCalledTimes(1);
  });

  it('renders the hero and children content', () => {
    render(h(ReviewLayout, makeLayoutProps()));
    expect(screen.getByTestId('hero')).toHaveTextContent('HERO');
    expect(screen.getByTestId('child')).toHaveTextContent('ROW');
  });

  it('renders the primary button with its label, Primary variant and default type', () => {
    render(h(ReviewLayout, makeLayoutProps()));
    const btn = screen.getByRole('button', { name: 'Confirm' });
    expect(btn).toHaveAttribute('data-variant', 'primary');
    expect(btn).toHaveAttribute('type', 'button');
    expect(btn).not.toHaveAttribute('data-testid');
  });

  it("honors an explicit 'submit' type and forwards data-testid on the primary action", () => {
    const primary: ReviewAction = {
      label: 'Confirm',
      onPress: jest.fn(),
      type: 'submit',
      'data-testid': 'confirm-cta'
    };
    render(h(ReviewLayout, makeLayoutProps({ primary })));
    const btn = screen.getByTestId('confirm-cta');
    expect(btn).toHaveAttribute('type', 'submit');
  });

  it('invokes onPress when the primary button is clicked', () => {
    const onPress = jest.fn();
    render(h(ReviewLayout, makeLayoutProps({ primary: { label: 'Confirm', onPress } })));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('does not render a secondary button when secondary is omitted', () => {
    render(h(ReviewLayout, makeLayoutProps()));
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('renders the secondary button (Secondary variant, button type) and fires its onPress', () => {
    const onPress = jest.fn();
    const secondary: ReviewAction = { label: 'Back', onPress };
    render(h(ReviewLayout, makeLayoutProps({ secondary })));
    const btn = screen.getByRole('button', { name: 'Back' });
    expect(btn).toHaveAttribute('data-variant', 'secondary');
    expect(btn).toHaveAttribute('type', 'button');
    fireEvent.click(btn);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('renders the orange hero divider by default and omits it when heroDivider is false', () => {
    const { container: withDivider } = render(h(ReviewLayout, makeLayoutProps()));
    expect(withDivider.querySelector('.bg-primary-500')).toBeInTheDocument();

    const { container: withoutDivider } = render(h(ReviewLayout, makeLayoutProps({ heroDivider: false })));
    expect(withoutDivider.querySelector('.bg-primary-500')).not.toBeInTheDocument();
  });

  it('applies row dividers by default and omits them when dividers is false', () => {
    const { container: withDividers } = render(h(ReviewLayout, makeLayoutProps()));
    expect(withDividers.querySelector('.divide-y')).toBeInTheDocument();

    const { container: withoutDividers } = render(h(ReviewLayout, makeLayoutProps({ dividers: false })));
    expect(withoutDividers.querySelector('.divide-y')).not.toBeInTheDocument();
  });
});
