import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { ButtonVariant } from 'components/Button';
import { EarnDepositTransaction } from 'lib/miden/db/types';
import { NoteTypeEnum } from 'lib/miden/types';

import { EarnSuccess } from './EarnSuccess';
import type { ReceiptRow, TransactionSuccessLayoutProps } from './TransactionSuccessLayout';

/**
 * `EarnSuccess` is the routed receipt for a completed `earn-deposit` row: a
 * "{amount} {symbol} ↑ {market}" summary pill plus Market / Total Deposited /
 * Transaction ID rows, all derived from the tracking row. These tests assert
 * the derived strings and the action wiring (Done → onDoneClick, View Details →
 * navigate('/earn/positions'), close → onDoneClick).
 *
 * We mock the shared layout module to (a) keep coverage scoped to
 * `EarnSuccess.tsx` and (b) capture the props/rows it derives. `react-i18next`
 * is mocked to return the caller's `defaultValue` (or the raw key), mirroring
 * the sibling `TransactionSuccess.test.tsx`.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key
  })
}));

// EarnSuccess only needs the `ButtonVariant` enum from this module. Provide the
// real string values so `variant` assertions are meaningful without pulling in
// the full Button component tree.
jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost' }
}));

const mockNavigate = jest.fn();
jest.mock('lib/woozie', () => ({ navigate: (...args: unknown[]) => mockNavigate(...args) }));

// Same shims the sibling TransactionSummaryBadge.test.tsx uses: `formatAmount`
// echoes the raw base units (decimal handling is that helper's own test's job)
// and the metadata module avoids the SDK import graph.
jest.mock('lib/shared/format', () => ({
  formatAmount: (amount: bigint) => String(amount)
}));
jest.mock('lib/miden/metadata', () => ({
  MIDEN_METADATA: { symbol: 'MIDEN', decimals: 6 }
}));

// The wallet store only supplies `assetsMetadata`; empty → the USDC fallbacks.
let mockAssetsMetadata: Record<string, { symbol: string; decimals: number }> | undefined = {};
jest.mock('lib/store', () => ({
  useWalletStore: (selector: (state: { assetsMetadata: unknown }) => unknown) =>
    selector({ assetsMetadata: mockAssetsMetadata })
}));

// Captures the last props handed to the shared layout. `mock`-prefixed so
// jest's factory-hoisting allows the out-of-scope reference.
let mockLastLayoutProps: TransactionSuccessLayoutProps | undefined;
let mockLastRows: ReceiptRow[] | undefined;
let mockLastPill: { lhs?: React.ReactNode; rhs?: React.ReactNode; separator?: React.ReactNode } | undefined;

jest.mock('./TransactionSuccessLayout', () => ({
  __esModule: true,
  TransactionSuccessLayout: (props: TransactionSuccessLayoutProps) => {
    mockLastLayoutProps = props;
    return (
      <div data-testid="layout">
        <span data-testid="header-title">{props.headerTitle}</span>
        <span data-testid="title">{props.title}</span>
        <button data-testid="primary" onClick={props.primaryAction.onClick}>
          {props.primaryAction.label}
        </button>
        {props.secondaryAction && (
          <button data-testid="secondary" onClick={props.secondaryAction.onClick}>
            {props.secondaryAction.label}
          </button>
        )}
        <button data-testid="close" aria-label="close" onClick={props.onClose} />
        {props.children}
      </div>
    );
  },
  SuccessSummaryPill: (props: { lhs?: React.ReactNode; rhs?: React.ReactNode; separator?: React.ReactNode }) => {
    mockLastPill = props;
    return (
      <div data-testid="pill">
        {props.lhs} {props.rhs}
      </div>
    );
  },
  SuccessDivider: () => <hr data-testid="divider" />,
  ReceiptRows: ({ rows }: { rows: ReceiptRow[] }) => {
    mockLastRows = rows;
    return <div data-testid="rows" />;
  }
}));

/** A completed earn-deposit row: 10 USDC (6dp base units) into DUMMY_LENDING. */
const earnDeposit = () =>
  new EarnDepositTransaction(
    'mtst1sender',
    10_000_000n,
    '0x0000000000000000000000000000000000000001',
    'DUMMY_LENDING:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
    'mtst1faucet',
    { recipientId: 'mtst1allocator', noteType: NoteTypeEnum.Public, recallBlocks: 2000 }
  );

describe('EarnSuccess', () => {
  beforeEach(() => {
    mockLastLayoutProps = undefined;
    mockLastRows = undefined;
    mockLastPill = undefined;
    mockAssetsMetadata = {};
    mockNavigate.mockClear();
  });

  it('renders the earn title and derives the pill from the row (USDC fallback + market name)', () => {
    render(<EarnSuccess transaction={earnDeposit()} onDoneClick={() => {}} />);

    expect(screen.getByTestId('title')).toHaveTextContent("You're Earning!");
    expect(mockLastPill?.lhs).toBe('10000000 USDC');
    expect(mockLastPill?.rhs).toBe('DUMMY-LENDING');
    expect(mockLastPill?.separator).toBeTruthy();
  });

  it('uses the faucet metadata symbol/decimals when present', () => {
    mockAssetsMetadata = { mtst1faucet: { symbol: 'mUSDC', decimals: 4 } };
    render(<EarnSuccess transaction={earnDeposit()} onDoneClick={() => {}} />);

    expect(mockLastPill?.lhs).toBe('10000000 mUSDC');
  });

  it('builds Market, Total Deposited, and Transaction ID rows', () => {
    render(
      <EarnSuccess
        transaction={earnDeposit()}
        txHash="0xabcdef1234567890"
        onDoneClick={() => {}}
        onViewExplorer={() => {}}
      />
    );

    const labels = (mockLastRows ?? []).map(row => row.label);
    expect(labels).toEqual(['Market', 'Total Deposited', 'Transaction ID']);
    expect(mockLastRows?.[0]?.value).toBe('DUMMY-LENDING');
    expect(mockLastRows?.[1]?.value).toBe('10000000 USDC');
  });

  it('wires Done to onDoneClick and View Details to the positions route', () => {
    const onDoneClick = jest.fn();
    render(<EarnSuccess transaction={earnDeposit()} onDoneClick={onDoneClick} />);

    expect(mockLastLayoutProps!.primaryAction.variant).toBe(ButtonVariant.Primary);
    expect(mockLastLayoutProps!.secondaryAction!.variant).toBe(ButtonVariant.Secondary);

    fireEvent.click(screen.getByTestId('primary'));
    expect(onDoneClick).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('secondary'));
    expect(mockNavigate).toHaveBeenCalledWith('/earn/positions');

    fireEvent.click(screen.getByTestId('close'));
    expect(onDoneClick).toHaveBeenCalledTimes(2);
  });

  it('renders no pill sides when the row is missing', () => {
    render(<EarnSuccess onDoneClick={() => {}} />);

    expect(mockLastPill?.lhs).toBeUndefined();
    expect(mockLastPill?.rhs).toBeUndefined();
  });
});
