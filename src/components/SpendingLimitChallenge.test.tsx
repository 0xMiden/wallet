import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { spendsDigest, type SpendingLimitAssessment } from 'lib/miden/spending-limits/types';

import { formatUsdMicroAmount, SpendingLimitChallenge } from './SpendingLimitChallenge';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } })
}));

jest.mock('lib/ui/drawer', () => ({
  Drawer: ({ open, children, onOpenChange }: any) =>
    open ? (
      <div data-testid="challenge-drawer">
        {children}
        <button type="button" onClick={() => onOpenChange(false)}>
          dismiss
        </button>
      </div>
    ) : null,
  DrawerContent: ({ children, ...rest }: any) => <div {...rest}>{children}</div>,
  DrawerHeader: ({ children }: any) => <header>{children}</header>,
  DrawerTitle: ({ children }: any) => <h2>{children}</h2>
}));

jest.mock('./StrictActionAuthentication', () => ({
  StrictActionAuthentication: ({ onResult, reason }: any) => (
    <div data-testid="strict-authentication">
      <span>{reason}</span>
      <button type="button" onClick={() => onResult('authenticated')}>
        authenticate
      </button>
      <button type="button" onClick={() => onResult('cancelled')}>
        cancel-authentication
      </button>
    </div>
  )
}));

const breachAssessment = (): SpendingLimitAssessment => ({
  accountId: 'account-a',
  usdAmount: 110_000_000n,
  revision: 'revision-1',
  assessedAt: 100,
  breach: {
    spent: 0n,
    proposedTotal: 110_000_000n,
    limit: 100_000_000n,
    overBy: 10_000_000n,
    resetAt: 200
  }
});

const noResetAssessment = (): SpendingLimitAssessment => ({
  ...breachAssessment(),
  breach: { spent: 0n, proposedTotal: 110_000_000n, limit: 100_000_000n, overBy: 10_000_000n, resetAt: null }
});

const unpricedContext = () => ({
  accountId: 'account-a',
  spends: [{ faucetId: 'faucet-a', amount: 20n }],
  revision: 'revision-1'
});

// What `breachAssessment()` was computed from - the assessment carries no spends of its own.
const breachSpends = [{ faucetId: 'faucet-a', amount: 20n }];

describe('SpendingLimitChallenge', () => {
  it('renders the dollar figures of a breach', () => {
    render(<SpendingLimitChallenge assessment={breachAssessment()} onResult={jest.fn()} />);

    expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();
    expect(screen.getByText('spendingLimitChallengeTitle')).toBeInTheDocument();
    expect(screen.getByText('$110.00')).toBeInTheDocument();
    expect(screen.getByText('$100.00')).toBeInTheDocument();
    expect(screen.getByText('$10.00')).toBeInTheDocument();
    expect(screen.getByText('spendingLimitChangeInSettings')).toBeInTheDocument();
    expect(screen.getByText('spendingLimitTransactionAuthenticationReason')).toBeInTheDocument();
    expect(screen.queryByText('spendingLimitPriceUnavailable')).not.toBeInTheDocument();
  });

  it('renders the no-automatic-reset copy when the breach has no reset time', () => {
    render(<SpendingLimitChallenge assessment={noResetAssessment()} onResult={jest.fn()} />);

    expect(screen.getByText('spendingLimitNoAutomaticReset')).toBeInTheDocument();
  });

  it('renders the unvalued variant without inventing a figure', () => {
    render(<SpendingLimitChallenge unpriced={unpricedContext()} onResult={jest.fn()} />);

    expect(screen.getByText('spendingLimitPriceUnavailable')).toBeInTheDocument();
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
    expect(screen.getByText('spendingLimitChangeInSettings')).toBeInTheDocument();
    expect(screen.getByText('spendingLimitTransactionAuthenticationReason')).toBeInTheDocument();
  });

  it('mints a usd authorization bound to the exact spends, recording the assessed dollar figure', () => {
    const onResult = jest.fn();
    render(
      <SpendingLimitChallenge
        assessment={breachAssessment()}
        spends={breachSpends}
        onResult={onResult}
        now={() => 1_000}
        makeId={() => 'auth-1'}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'authenticate' }));

    expect(onResult).toHaveBeenCalledWith({
      kind: 'usd',
      id: 'auth-1',
      accountId: 'account-a',
      usdAmount: 110_000_000n,
      spendsDigest: spendsDigest(breachSpends),
      revision: 'revision-1',
      issuedAt: 1_000,
      expiresAt: 1_120
    });
  });

  it('uses the current time when no clock is injected', () => {
    const onResult = jest.fn();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(120_000);
    try {
      render(
        <SpendingLimitChallenge
          assessment={breachAssessment()}
          spends={breachSpends}
          onResult={onResult}
          makeId={() => 'auth-1'}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: 'authenticate' }));

      expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ issuedAt: 120, expiresAt: 240 }));
    } finally {
      clock.mockRestore();
    }
  });

  it('mints an unpriced authorization bound to the spends', () => {
    const onResult = jest.fn();
    render(
      <SpendingLimitChallenge
        unpriced={unpricedContext()}
        onResult={onResult}
        now={() => 1_000}
        makeId={() => 'auth-2'}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'authenticate' }));

    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'unpriced',
        id: 'auth-2',
        accountId: 'account-a',
        revision: 'revision-1',
        spendsDigest: expect.any(String)
      })
    );
  });

  it.each(['cancel-authentication', 'dismiss'])('returns cancellation from %s', action => {
    const onResult = jest.fn();
    render(<SpendingLimitChallenge assessment={breachAssessment()} onResult={onResult} />);

    fireEvent.click(screen.getByRole('button', { name: action }));

    expect(onResult).toHaveBeenCalledWith(undefined);
  });

  it('returns undefined when the unpriced drawer is dismissed', () => {
    const onResult = jest.fn();
    render(<SpendingLimitChallenge unpriced={unpricedContext()} onResult={onResult} />);

    fireEvent.click(screen.getByRole('button', { name: 'dismiss' }));

    expect(onResult).toHaveBeenCalledWith(undefined);
  });
});

describe('formatUsdMicroAmount', () => {
  it.each([
    [0n, '$0.00'],
    [1n, '$0.00'],
    [10_000n, '$0.01'],
    [1_000_000n, '$1.00'],
    [1_500_000n, '$1.50'],
    [1_234_567n, '$1.23'],
    // Load-bearing case: 123.456789 rounds to $123.46 but formatter truncates to $123.45 (third decimal is 6, rounding and truncation diverge).
    [123_456_789n, '$123.45']
  ])('formats %s as %s', (value, expected) => {
    expect(formatUsdMicroAmount(value)).toBe(expected);
  });

  it('throws RangeError for negative values', () => {
    expect(() => formatUsdMicroAmount(-1n)).toThrow(RangeError);
    expect(() => formatUsdMicroAmount(-1_000_000n)).toThrow(RangeError);
  });
});
