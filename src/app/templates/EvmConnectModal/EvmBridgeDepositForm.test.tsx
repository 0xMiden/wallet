import React from 'react';

import { render, screen } from '@testing-library/react';

import { TEST_EVM_USDC } from 'lib/epoch/testing/bridge-config';
import type { UIToken } from 'screens/send-flow/types';

import { EvmBridgeDepositForm } from './EvmBridgeDepositForm';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// The real SelectAmount renders its children below the amount field
// (SelectAmount.tsx), which is where the form's warning lives.
jest.mock('screens/send-flow/SelectAmount', () => ({
  SelectAmount: ({
    children,
    outputSymbol,
    tokenLabel
  }: {
    children?: React.ReactNode;
    outputSymbol?: string;
    tokenLabel?: string;
  }) => (
    <div data-testid="select-amount" data-output-symbol={outputSymbol} data-token-label={tokenLabel}>
      {children}
    </div>
  )
}));

jest.mock('screens/send-flow/bridge-networks', () => ({
  DEFAULT_BRIDGE_NETWORK: { id: 'sepolia', name: 'Sepolia', chainId: 11155111 }
}));

jest.mock('./EvmWalletHeader', () => ({
  EvmWalletHeader: () => null
}));

jest.mock('app/icons/v2', () => ({
  Icon: () => null,
  IconName: { WarningFill: 'WarningFill' }
}));

const TOKEN: UIToken = { id: 'eth', name: 'ETH', decimals: 18, balance: 0, fiatPrice: 0, scaleIsKnown: true };

describe('EvmBridgeDepositForm (#875)', () => {
  it('carries its own test-funds warning inside the amount form', () => {
    render(
      <EvmBridgeDepositForm
        token={TOKEN}
        tokenLabel="ETH"
        arrivingName="ETH"
        amount=""
        isValidAmount={false}
        evmAddress="0xabc"
        onAmountChange={jest.fn()}
        onSelectToken={jest.fn()}
        onSwitch={jest.fn()}
        onContinue={jest.fn()}
      />
    );

    const warning = screen.getByTestId('bridge-test-funds-warning');
    expect(screen.getByTestId('select-amount')).toContainElement(warning);
    expect(warning).toHaveAttribute('role', 'note');
    expect(warning).toHaveAttribute('data-tone', 'warning');
    expect(warning.querySelector('[data-slot="title"]')?.textContent).toBe('bridgeTestFundsTitle');
    expect(warning.querySelector('[data-slot="body"]')?.textContent).toBe('bridgeTestFundsBody');
  });

  it('says an ETH deposit arrives as ETH', () => {
    render(
      <EvmBridgeDepositForm
        token={TOKEN}
        tokenLabel="ETH"
        arrivingName="ETH"
        amount=""
        isValidAmount={false}
        evmAddress="0xabc"
        onAmountChange={jest.fn()}
        onSelectToken={jest.fn()}
        onSwitch={jest.fn()}
        onContinue={jest.fn()}
      />
    );

    expect(screen.getByTestId('select-amount')).toHaveAttribute('data-output-symbol', 'ETH');
  });
});

describe('EvmBridgeDepositForm testnet bridge USDC label', () => {
  const USDC: UIToken = {
    id: TEST_EVM_USDC.address,
    name: 'USDC',
    decimals: 18,
    balance: 0,
    fiatPrice: 1,
    scaleIsKnown: true
  };

  // The screen names the token and what it arrives as once, by the route, for this step and the Review alike.
  it.each([
    ['Fast', 'Test Epoch USDC'],
    ['Slow', 'USDC']
  ])('forwards the token name and the %s arriving name unchanged', (_route, arrivingName) => {
    render(
      <EvmBridgeDepositForm
        token={USDC}
        tokenLabel="Test Epoch USDC"
        arrivingName={arrivingName}
        amount=""
        isValidAmount={false}
        evmAddress="0xabc"
        onAmountChange={jest.fn()}
        onSelectToken={jest.fn()}
        onSwitch={jest.fn()}
        onContinue={jest.fn()}
      />
    );

    const field = screen.getByTestId('select-amount');
    expect(field).toHaveAttribute('data-token-label', 'Test Epoch USDC');
    expect(field).toHaveAttribute('data-output-symbol', arrivingName);
  });
});
