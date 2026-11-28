import React from 'react';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

import { PendingDepositRow } from './PendingDepositRow';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key} ${JSON.stringify(params)}` : key)
  })
}));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

describe('PendingDepositRow', () => {
  it('shows a waiting deposit with its amount, token and network, and goes back to it on a tap', () => {
    const onClick = jest.fn();
    render(
      <PendingDepositRow
        state="waiting"
        amount={{ amount: 70250000n, decimals: 6 }}
        symbol="USDC"
        networkName="Ethereum"
        onClick={onClick}
      />
    );
    const row = screen.getByTestId('pending-deposit-row');
    expect(row).toHaveTextContent('depositFlowWaitingTitle');
    expect(row).toHaveTextContent('depositFlowPendingFrom {"amount":"70.25 USDC","network":"Ethereum"}');
    expect(row).toHaveAttribute('data-state', 'waiting');
    fireEvent.click(row);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(hapticLight).toHaveBeenCalledTimes(1);
  });

  it('asks for a tap once the deposit is received', () => {
    render(
      <PendingDepositRow
        state="received"
        amount={{ amount: '1.5' }}
        symbol="ETH"
        networkName="Base"
        onClick={jest.fn()}
      />
    );
    expect(screen.getByTestId('pending-deposit-row')).toHaveTextContent('depositFlowPendingReceived');
  });
});
