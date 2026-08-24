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

it('promotes the body title to h1 when the header carries no title', () => {
  render(<TransactionSuccessLayout {...baseProps} headerTitle="" />);

  // Every receipt passes an empty header title, so this is the screen's only
  // heading — as an h2 it left the page with no h1 and the header announcing a
  // nameless level-1 heading.
  expect(screen.getByRole('heading', { level: 1, name: 'Transaction Complete!' })).toBeInTheDocument();
});

it('keeps the body title one level below a titled header', () => {
  render(<TransactionSuccessLayout {...baseProps} headerTitle="Success!" />);

  expect(screen.getByRole('heading', { level: 2, name: 'Transaction Complete!' })).toBeInTheDocument();
});

it('takes focus on mount so the outcome is announced', () => {
  render(<TransactionSuccessLayout {...baseProps} headerTitle="" />);

  // The receipt replaces the in-progress view in place — no navigation, no live
  // region — so without this the result of the transaction the user just
  // authorized was never announced, and focus sat on the unmounted view's body.
  const heading = screen.getByRole('heading', { level: 1, name: 'Transaction Complete!' });
  expect(heading).toHaveFocus();
  // Focusable, but not a tab stop: -1 is the standard shape for a focus target.
  expect(heading).toHaveAttribute('tabindex', '-1');
});

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
