import React from 'react';

import { render, screen } from '@testing-library/react';

import type { UIToken } from 'screens/send-flow/types';

import { EvmBridgeDepositForm } from './EvmBridgeDepositForm';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// The real SelectAmount renders its children below the amount field
// (SelectAmount.tsx), which is where the form's warning lives.
jest.mock('screens/send-flow/SelectAmount', () => ({
  SelectAmount: ({ children }: { children?: React.ReactNode }) => <div data-testid="select-amount">{children}</div>
}));

jest.mock('screens/send-flow/bridge-networks', () => ({
  DEFAULT_BRIDGE_NETWORK: { id: 'sepolia', name: 'Sepolia', chainId: 11155111 },
  BRIDGE_OUTPUT_TOKEN_SYMBOL: 'ETH'
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
    expect(warning).toHaveTextContent('bridgeTestFundsTitle');
    expect(warning).toHaveTextContent('bridgeTestFundsBody');
  });
});
