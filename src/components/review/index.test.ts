import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

// Import EVERY value export through the barrel under test so `index.ts`'s
// re-export lines are executed and counted. Type-only exports are erased by the
// compiler, so exercising the runtime exports fully covers the barrel.
import { ReviewLayout } from './index';
import type { ReviewAction, ReviewLayoutProps } from './index';

const h = React.createElement;

// ---------------------------------------------------------------------------
// Module mocks (mirrors the sibling ReviewLayout test setup)
// ---------------------------------------------------------------------------

// The network banner now tops every review screen, so the wallet names the chain on each surface
// that commits value. Its sheet and the effective-endpoint lookup are tested in their own suites;
// stubbing only those keeps the banner itself real here, so the assertion is not on a stub.
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getTestNetworkNameKey: () => 'testnet'
}));
jest.mock('components/NetworkModeSheet', () => ({ NetworkModeSheet: () => null }));

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

// react-i18next: return the key, but fold the interpolation `value` in so any
// interpolated caller content stays observable in the DOM.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { value?: string }) => (opts && opts.value !== undefined ? `${key}|${opts.value}` : key)
  })
}));

// ---------------------------------------------------------------------------
// Barrel wiring — the export identity is what index.ts is responsible for.
// ---------------------------------------------------------------------------

describe('components/review barrel (index.ts)', () => {
  it('re-exports ReviewLayout as a callable function', () => {
    expect(typeof ReviewLayout).toBe('function');
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
    // The banner is a button too, so count the ACTIONS: the point of this case is that no
    // secondary action renders, not that the screen holds exactly one button.
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button').filter(b => b.dataset.testid !== 'network-mode-banner')).toHaveLength(1);
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

  it('applies row dividers by default and omits them when dividers is false', () => {
    const { container: withDividers } = render(h(ReviewLayout, makeLayoutProps()));
    expect(withDividers.querySelector('.divide-y')).toBeInTheDocument();

    const { container: withoutDividers } = render(h(ReviewLayout, makeLayoutProps({ dividers: false })));
    expect(withoutDividers.querySelector('.divide-y')).not.toBeInTheDocument();
  });
});
