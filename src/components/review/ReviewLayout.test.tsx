import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { ReviewLayout, ReviewAction } from './ReviewLayout';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Hook is exercised elsewhere; here we only assert it's invoked and keep it a
// no-op so it doesn't mutate document.body across tests.
const useHideNavbarWhileOpenMock = jest.fn();
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
      expect(screen.getAllByRole('button')).toHaveLength(1);
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

  describe('heroDivider branch', () => {
    it('renders the orange hero divider by default', () => {
      const { container } = render(<ReviewLayout {...makeProps()} />);
      expect(container.querySelector('.bg-primary-500')).toBeInTheDocument();
    });

    it('omits the hero divider when heroDivider is false', () => {
      const { container } = render(<ReviewLayout {...makeProps({ heroDivider: false })} />);
      expect(container.querySelector('.bg-primary-500')).not.toBeInTheDocument();
    });
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
