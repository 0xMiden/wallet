import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { TransactionSuccessLayout } from './TransactionSuccessLayout';

/**
 * Covers the two props the Guardian receipt introduced to the shared layout:
 * `hero` (custom artwork in place of the green check) and `secondaryFirst`
 * (secondary CTA stacked above the primary one).
 *
 * Both were previously only asserted through a mocked layout in
 * `GuardianSwitchSuccess.test.tsx`, which proves the props are PASSED but not
 * that the layout honours them — the ordering there was that suite's own stub.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('components/Button', () => ({
  Button: ({ title, onClick }: { title: string; onClick: () => void }) => (
    <button data-testid="footer-action" onClick={onClick}>
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary' }
}));

// Exposes onClose rather than swallowing it: the receipt's header X is one of the
// two ways out of the screen, and a stub that drops the prop lets the layout stop
// wiring it without a single test noticing.
jest.mock('components/ScreenHeader', () => ({
  ScreenHeader: ({ title, onClose }: { title: string; onClose?: () => void }) => (
    <div>
      {title}
      <button data-testid="header-close" onClick={onClose} />
    </div>
  )
}));

jest.mock('lib/mobile/useHideNavbarWhileOpen', () => ({
  useHideNavbarWhileOpen: jest.fn()
}));

const baseProps = {
  headerTitle: 'Success!',
  title: 'Transaction Complete!',
  primaryAction: { label: 'Done', onClick: jest.fn() },
  onClose: jest.fn()
};

const footerLabels = () => screen.getAllByTestId('footer-action').map(button => button.textContent);

it('renders the green check hero when no custom artwork is supplied', () => {
  render(<TransactionSuccessLayout {...baseProps} />);

  // The default hero is decorative, so it is only reachable through the DOM.
  expect(document.querySelector('svg')).toBeInTheDocument();
  expect(screen.queryByTestId('custom-hero')).not.toBeInTheDocument();
});

it('replaces the check hero entirely with custom artwork', () => {
  render(<TransactionSuccessLayout {...baseProps} hero={<span data-testid="custom-hero" />} />);

  expect(screen.getByTestId('custom-hero')).toBeInTheDocument();
  // A rotation receipt shows robot-and-shield art instead of the check, so the
  // default must not render alongside it.
  expect(document.querySelector('svg')).not.toBeInTheDocument();
});

it('stacks the primary action above the secondary one by default', () => {
  render(
    <TransactionSuccessLayout {...baseProps} secondaryAction={{ label: 'View in Activities', onClick: jest.fn() }} />
  );

  expect(footerLabels()).toEqual(['Done', 'View in Activities']);
});

it('inverts the stack when secondaryFirst is set', () => {
  render(
    <TransactionSuccessLayout
      {...baseProps}
      secondaryAction={{ label: 'View in Activities', onClick: jest.fn() }}
      secondaryFirst
    />
  );

  expect(footerLabels()).toEqual(['View in Activities', 'Done']);
});

it('renders a lone primary action when there is no secondary one, ordering flag notwithstanding', () => {
  render(<TransactionSuccessLayout {...baseProps} secondaryFirst />);

  expect(footerLabels()).toEqual(['Done']);
});

it("invokes the caller's own handlers from both CTAs and the header close", () => {
  const primary = jest.fn();
  const secondary = jest.fn();
  const onClose = jest.fn();
  render(
    <TransactionSuccessLayout
      {...baseProps}
      primaryAction={{ label: 'Done', onClick: primary }}
      secondaryAction={{ label: 'View in Activities', onClick: secondary }}
      onClose={onClose}
    />
  );

  // Every exit from the receipt, wired end to end: asserting the labels alone
  // left the layout free to render buttons that do nothing.
  fireEvent.click(screen.getByText('Done'));
  fireEvent.click(screen.getByText('View in Activities'));
  fireEvent.click(screen.getByTestId('header-close'));

  expect(primary).toHaveBeenCalledTimes(1);
  expect(secondary).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
});
