import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { ReviewLayout, ReviewAction } from './ReviewLayout';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Hook is exercised elsewhere; here we only assert it's invoked and keep it a
// no-op so it doesn't mutate document.body across tests.
const useHideNavbarWhileOpenMock = jest.fn();
// The network banner now tops this screen, so the wallet names the chain on every surface that
// commits value. Its sheet and the effective-endpoint lookup are tested in their own suites;
// stubbing only those keeps the banner itself real here, so the assertion is not on a stub.
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getTestNetworkNameKey: () => 'testnet'
}));
jest.mock('components/NetworkModeSheet', () => ({ NetworkModeSheet: () => null }));

jest.mock('lib/mobile/useHideNavbarWhileOpen', () => ({
  useHideNavbarWhileOpen: (...a: any[]) => useHideNavbarWhileOpenMock(...a)
}));

// Replace the real Button (framer-motion / haptics / icon tree) with a plain
// <button> that forwards exactly the props ReviewLayout wires up, so we can
// assert type / variant / data-testid / onClick precisely.
jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost' },
  Button: ({ title, onClick, type, variant, className, ...props }: any) => (
    <button
      type={type}
      onClick={onClick}
      data-variant={variant}
      data-testid={props['data-testid']}
      className={className}
    >
      {title}
    </button>
  )
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const hero = <div data-testid="hero">HERO</div>;
const child = <div data-testid="child">ROW</div>;

const makeProps = (overrides: Partial<React.ComponentProps<typeof ReviewLayout>> = {}) => ({
  hero,
  children: child,
  primary: { label: 'Confirm', onPress: jest.fn() } as ReviewAction,
  ...overrides
});

describe('ReviewLayout', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('hides the bottom navbar while mounted', () => {
    render(<ReviewLayout {...makeProps()} />);
    expect(useHideNavbarWhileOpenMock).toHaveBeenCalledTimes(1);
  });

  // This layout hides the tab bar, and the network ribbon lives in the tab bar's footer, so these
  // screens showed no network at all. The banner is the replacement, and it is rendered here
  // rather than by each caller because this layout IS what the two of them share.
  it('names the network, since hiding the navbar also hides the ribbon', () => {
    render(<ReviewLayout {...makeProps()} />);
    expect(screen.getByTestId('network-mode-banner')).toBeInTheDocument();
  });

  it('renders the hero and children content', () => {
    render(<ReviewLayout {...makeProps()} />);
    expect(screen.getByTestId('hero')).toHaveTextContent('HERO');
    expect(screen.getByTestId('child')).toHaveTextContent('ROW');
  });

  describe('primary action', () => {
    it('renders the primary button with its label and Primary variant', () => {
      render(<ReviewLayout {...makeProps()} />);
      const btn = screen.getByRole('button', { name: 'Confirm' });
      expect(btn).toBeInTheDocument();
      expect(btn).toHaveAttribute('data-variant', 'primary');
    });

    it('carries only layout classes (w-full, max-w-none), no restyling override', () => {
      render(<ReviewLayout {...makeProps()} />);
      const btn = screen.getByRole('button', { name: 'Confirm' });
      expect(btn).toHaveClass('w-full', 'max-w-none');
      expect(btn.className).not.toMatch(/rounded-full|text-base|font-semibold/);
    });

    it("defaults the primary button type to 'button' when not provided", () => {
      render(<ReviewLayout {...makeProps()} />);
      expect(screen.getByRole('button', { name: 'Confirm' })).toHaveAttribute('type', 'button');
    });

    it("honors an explicit 'submit' type on the primary action", () => {
      const primary: ReviewAction = { label: 'Confirm', onPress: jest.fn(), type: 'submit' };
      render(<ReviewLayout {...makeProps({ primary })} />);
      expect(screen.getByRole('button', { name: 'Confirm' })).toHaveAttribute('type', 'submit');
    });

    it("forwards the primary action's data-testid when provided", () => {
      const primary: ReviewAction = { label: 'Confirm', onPress: jest.fn(), 'data-testid': 'confirm-cta' };
      render(<ReviewLayout {...makeProps({ primary })} />);
      expect(screen.getByTestId('confirm-cta')).toBeInTheDocument();
    });

    it('does not set a data-testid on the primary button when omitted', () => {
      render(<ReviewLayout {...makeProps()} />);
      expect(screen.getByRole('button', { name: 'Confirm' })).not.toHaveAttribute('data-testid');
    });

    it('invokes onPress when the primary button is clicked', () => {
      const onPress = jest.fn();
      render(<ReviewLayout {...makeProps({ primary: { label: 'Confirm', onPress } })} />);
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
      expect(onPress).toHaveBeenCalledTimes(1);
    });
  });

  describe('secondary action', () => {
    it('does not render a secondary button when secondary is omitted', () => {
      render(<ReviewLayout {...makeProps()} />);
      expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
      // The banner is a button too, so count the ACTIONS: the point of this case is that no
      // secondary action renders, not that the screen holds exactly one button.
      expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
      expect(screen.getAllByRole('button').filter(b => b.dataset.testid !== 'network-mode-banner')).toHaveLength(1);
    });

    it('renders the secondary button with Secondary variant and button type', () => {
      const secondary: ReviewAction = { label: 'Back', onPress: jest.fn() };
      render(<ReviewLayout {...makeProps({ secondary })} />);
      const btn = screen.getByRole('button', { name: 'Back' });
      expect(btn).toHaveAttribute('data-variant', 'secondary');
      expect(btn).toHaveAttribute('type', 'button');
    });

    it('invokes the secondary onPress when clicked', () => {
      const onPress = jest.fn();
      render(<ReviewLayout {...makeProps({ secondary: { label: 'Back', onPress } })} />);
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      expect(onPress).toHaveBeenCalledTimes(1);
    });
  });

  it('draws no bar between the hero and the rows, whatever the flow', () => {
    for (const accent of ['brand', 'send', 'receive', 'earn', 'swap'] as const) {
      const { container, unmount } = render(<ReviewLayout {...makeProps({ accent })} />);
      expect(container.querySelector('.h-2.rounded-full')).not.toBeInTheDocument();
      unmount();
    }
  });

  describe('dividers branch', () => {
    it('applies row dividers on the children wrapper by default', () => {
      const { container } = render(<ReviewLayout {...makeProps()} />);
      expect(container.querySelector('.divide-y')).toBeInTheDocument();
    });

    it('omits row dividers when dividers is false', () => {
      const { container } = render(<ReviewLayout {...makeProps({ dividers: false })} />);
      expect(container.querySelector('.divide-y')).not.toBeInTheDocument();
      // Children still render inside the (now border-free) wrapper.
      expect(screen.getByTestId('child')).toBeInTheDocument();
    });
  });
});
