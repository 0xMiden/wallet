import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import type { WeeklyClaimReview } from 'lib/arcade/weekly-claim';

import { GcClaimReviewDrawer } from './GcClaimReviewDrawer';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: 'en' } })
}));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({
    open,
    children,
    onOpenChange
  }: {
    open: boolean;
    children: React.ReactNode;
    onOpenChange: (open: boolean) => void;
  }) =>
    open ? (
      <div role="dialog">
        <button onClick={() => onOpenChange(false)}>Dismiss</button>
        {children}
      </div>
    ) : null,
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DrawerDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>
}));
const quote: WeeklyClaimReview = {
  quoteId: 'quote-1',
  mode: 'claim',
  allocationWeekStart: '2026-10-19T00:00:00Z',
  expiresAt: '2026-10-25T23:59:59Z',
  nativeSymbol: 'MIDEN',
  requestFee: '0.001',
  issuerBudget: '0.002',
  receiptFeeBudget: '0.003'
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-10-25T23:59:58Z'));
});
afterEach(() => jest.useRealTimers());

it('leads with GC and total fees while keeping the full approval breakdown behind Details', () => {
  const onConfirm = jest.fn();
  const onCancel = jest.fn();
  render(<GcClaimReviewDrawer review={quote} busy={false} onConfirm={onConfirm} onCancel={onCancel} />);
  expect(onConfirm).not.toHaveBeenCalled();
  expect(screen.getByText('arcadeClaimAllocation')).toBeInTheDocument();
  expect(screen.getByText('arcadeClaimAllocationAmount')).toBeInTheDocument();
  expect(screen.getByText('0.006 MIDEN')).toBeInTheDocument();
  expect(screen.queryByText('Oct 19, 2026 UTC')).not.toBeInTheDocument();
  const details = screen.getByRole('button', { name: 'details' });
  expect(details).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(details);
  expect(details).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText('Oct 19, 2026 UTC')).toBeInTheDocument();
  for (const amount of ['0.001 MIDEN', '0.002 MIDEN', '0.003 MIDEN'])
    expect(screen.getByText(amount)).toBeInTheDocument();
  expect(screen.getByText('arcadeClaimSummary')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'arcadeConfirmClaim' }));
  expect(onConfirm).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'arcadeCancelReview' }));
  expect(onCancel).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(onCancel).toHaveBeenCalledTimes(2);
});

it('expires an open review and prevents approval', () => {
  const onConfirm = jest.fn();
  render(<GcClaimReviewDrawer review={quote} busy={false} onConfirm={onConfirm} onCancel={jest.fn()} />);
  act(() => jest.advanceTimersByTime(1000));
  expect(screen.getByRole('button', { name: 'arcadeConfirmClaim' })).toBeDisabled();
  expect(screen.getByRole('status')).toHaveTextContent('arcadeClaimReviewExpired');
  fireEvent.click(screen.getByRole('button', { name: 'arcadeConfirmClaim' }));
  expect(onConfirm).not.toHaveBeenCalled();
});

it('reviews recovery without promising a GC allocation or charging a new issuer budget', () => {
  render(
    <GcClaimReviewDrawer
      review={{ ...quote, mode: 'reclaim' }}
      busy={false}
      onConfirm={jest.fn()}
      onCancel={jest.fn()}
    />
  );
  expect(screen.getByRole('button', { name: 'arcadeConfirmReclaim' })).toBeEnabled();
  expect(screen.queryByText('arcadeClaimAllocationAmount')).not.toBeInTheDocument();
  expect(screen.queryByText('arcadeClaimIssuerBudget')).not.toBeInTheDocument();
  expect(screen.queryByText('arcadeClaimReceiptFeeBudget')).not.toBeInTheDocument();
  expect(screen.getByText('arcadeReclaimSummary')).toBeInTheDocument();
  expect(screen.getByText('arcadeReclaimRecoverableBudget')).toBeInTheDocument();
  expect(screen.getByText('0.002 MIDEN')).toBeInTheDocument();
});

it('renders no review without a quote and disables confirmation while busy', () => {
  const view = render(<GcClaimReviewDrawer review={null} busy={false} onConfirm={jest.fn()} onCancel={jest.fn()} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  view.rerender(<GcClaimReviewDrawer review={quote} busy onConfirm={jest.fn()} onCancel={jest.fn()} />);
  expect(screen.getByRole('button', { name: 'arcadeConfirmClaim' })).toBeDisabled();
});

it('reviews receipt acceptance with the GC amount, authenticated native refund and consume fee', () => {
  const onConfirm = jest.fn();
  render(
    <GcClaimReviewDrawer
      review={{ ...quote, mode: 'receive', nativeRefund: '0.000091' }}
      busy={false}
      onConfirm={onConfirm}
      onCancel={jest.fn()}
    />
  );
  expect(screen.getByText('arcadeReviewReceive')).toBeInTheDocument();
  expect(screen.getByText('arcadeClaimAllocationAmount')).toBeInTheDocument();
  expect(screen.getByText('arcadeReceiveFee')).toBeInTheDocument();
  expect(screen.getByText('0.000091 MIDEN')).toBeInTheDocument();
  expect(screen.queryByText('arcadeClaimIssuerBudget')).not.toBeInTheDocument();
  expect(screen.queryByText('arcadeClaimReceiptFeeBudget')).not.toBeInTheDocument();
  expect(onConfirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'arcadeConfirmReceive' }));
  expect(onConfirm).toHaveBeenCalledTimes(1);
});
