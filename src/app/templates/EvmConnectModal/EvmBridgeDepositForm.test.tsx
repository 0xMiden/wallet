import React from 'react';

import { render, screen } from '@testing-library/react';

import { TEST_BRIDGE_CONFIG_SNAPSHOT, TEST_EVM_USDC } from 'lib/epoch/testing/bridge-config';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
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

jest.mock('lib/remote-config/use-feature-availability', () => ({ useBridgeConfigSnapshot: () => ({}) }));
jest.mock('lib/remote-config/values', () => ({
  selectEvmUsdc: () => ({
    address: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69',
    symbol: 'USDC.e',
    decimals: 18,
    chainId: 1
  })
}));

// This realm's bridge config: the real, unloaded one, or the loaded testnet one a case sets.
let mockBridgeSnapshot: BridgeConfigSnapshot | undefined;
jest.mock('lib/remote-config/runtime', () =>
  jest
    .requireActual<typeof import('lib/epoch/testing/bridge-config')>('lib/epoch/testing/bridge-config')
    .remoteConfigRuntimeMock(() => mockBridgeSnapshot)
);
afterEach(() => {
  mockBridgeSnapshot = undefined;
});

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
    expect(warning).toHaveAttribute('role', 'note');
    expect(warning).toHaveAttribute('data-tone', 'warning');
    expect(warning.querySelector('[data-slot="title"]')?.textContent).toBe('bridgeTestFundsTitle');
    expect(warning.querySelector('[data-slot="body"]')?.textContent).toBe('bridgeTestFundsBody');
  });

  it('says the deposit arrives as the output token the config names', () => {
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

    expect(screen.getByTestId('select-amount')).toHaveAttribute('data-output-symbol', 'USDC.e');
  });
});

describe('EvmBridgeDepositForm testnet bridge USDC label', () => {
  const USDC: UIToken = {
    id: TEST_EVM_USDC.address,
    name: 'USDC.e',
    decimals: 18,
    balance: 0,
    fiatPrice: 1,
    scaleIsKnown: true
  };
  const renderForm = (token: UIToken) =>
    render(
      <EvmBridgeDepositForm
        token={token}
        amount=""
        isValidAmount={false}
        evmAddress="0xabc"
        onAmountChange={jest.fn()}
        onSelectToken={jest.fn()}
        onSwitch={jest.fn()}
        onContinue={jest.fn()}
      />
    );

  it('names the configured token and what it arrives as by the testnet label', () => {
    mockBridgeSnapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
    renderForm(USDC);

    const field = screen.getByTestId('select-amount');
    expect(field).toHaveAttribute('data-token-label', 'Test Epoch USDC');
    expect(field).toHaveAttribute('data-output-symbol', 'Test Epoch USDC');
  });

  it('keeps ETH on its symbol on testnet', () => {
    mockBridgeSnapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
    renderForm(TOKEN);

    expect(screen.getByTestId('select-amount')).toHaveAttribute('data-token-label', 'ETH');
  });

  it('keeps the chain symbols while no bridge config is loaded', () => {
    renderForm(USDC);

    const field = screen.getByTestId('select-amount');
    expect(field).toHaveAttribute('data-token-label', 'USDC.e');
    expect(field).toHaveAttribute('data-output-symbol', 'USDC.e');
  });
});
