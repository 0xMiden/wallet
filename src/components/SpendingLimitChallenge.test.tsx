import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { SpendingLimitChallenge } from './SpendingLimitChallenge';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } })
}));

jest.mock('lib/i18n/numbers', () => ({
  formatBigInt: (amount: bigint, decimals: number) => `${amount.toString()}:${decimals}`
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
  DrawerContent: ({ children }: any) => <div>{children}</div>,
  DrawerHeader: ({ children }: any) => <header>{children}</header>,
  DrawerTitle: ({ children }: any) => <h2>{children}</h2>
}));

jest.mock('./StrictActionAuthentication', () => ({
  StrictActionAuthentication: ({ onResult, reason }: any) => (
    <div>
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

const assessment = {
  accountId: 'account-a',
  faucetId: 'faucet-a',
  amount: 20n,
  revision: 'revision-1',
  assessedAt: 100,
  breaches: [
    { period: '24h' as const, spent: 90n, proposedTotal: 110n, limit: 100n, overBy: 10n, resetAt: 200 },
    { period: '7d' as const, spent: 240n, proposedTotal: 260n, limit: 250n, overBy: 10n, resetAt: null }
  ]
};

describe('SpendingLimitChallenge', () => {
  it('shows the proposed amount and every structured breach without recomputing policy values', () => {
    render(
      <SpendingLimitChallenge assessment={assessment} asset={{ symbol: 'MIDEN', decimals: 8 }} onResult={jest.fn()} />
    );

    expect(screen.getByText('spendingLimitChallengeTitle')).toBeInTheDocument();
    expect(screen.getByText('20:8 MIDEN')).toBeInTheDocument();
    expect(screen.getByText('100:8 MIDEN')).toBeInTheDocument();
    expect(screen.getByText('250:8 MIDEN')).toBeInTheDocument();
    expect(screen.getAllByText('10:8 MIDEN')).toHaveLength(2);
    expect(screen.getByText('spendingLimitPeriod24h')).toBeInTheDocument();
    expect(screen.getByText('spendingLimitPeriod7d')).toBeInTheDocument();
    expect(screen.getByText('spendingLimitNoAutomaticReset')).toBeInTheDocument();
    expect(screen.getByText('spendingLimitChangeInSettings')).toBeInTheDocument();
    expect(screen.getByText('spendingLimitTransactionAuthenticationReason')).toBeInTheDocument();
  });

  it('returns an exact short-lived authorization only after strict authentication', () => {
    const onResult = jest.fn();
    render(
      <SpendingLimitChallenge
        assessment={assessment}
        asset={{ symbol: 'MIDEN', decimals: 8 }}
        onResult={onResult}
        now={() => 120}
        makeId={() => 'authorization-1'}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'authenticate' }));

    expect(onResult).toHaveBeenCalledWith({
      id: 'authorization-1',
      accountId: 'account-a',
      faucetId: 'faucet-a',
      amount: 20n,
      revision: 'revision-1',
      issuedAt: 120,
      expiresAt: 240
    });
  });

  it('uses the current time when no clock is injected', () => {
    const onResult = jest.fn();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(120_000);
    try {
      render(
        <SpendingLimitChallenge
          assessment={assessment}
          asset={{ symbol: 'MIDEN', decimals: 8 }}
          onResult={onResult}
          makeId={() => 'authorization-1'}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: 'authenticate' }));

      expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ issuedAt: 120, expiresAt: 240 }));
    } finally {
      clock.mockRestore();
    }
  });

  it.each(['cancel-authentication', 'dismiss'])('returns cancellation from %s', action => {
    const onResult = jest.fn();
    render(
      <SpendingLimitChallenge assessment={assessment} asset={{ symbol: 'MIDEN', decimals: 8 }} onResult={onResult} />
    );

    fireEvent.click(screen.getByRole('button', { name: action }));

    expect(onResult).toHaveBeenCalledWith(undefined);
  });
});
