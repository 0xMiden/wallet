import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { EvmBridgeDepositForm } from './EvmBridgeDepositForm';
import { BRIDGE_SOURCE_NETWORK_JS } from '../../../../playwright/e2e/helpers/send-flow-scripts';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getTestNetworkNameKey: () => 'testnet' }));
jest.mock('components/TokenLogo', () => ({ TokenLogo: () => null }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticSelection: jest.fn() }));

const props = {
  token: { id: 'usdc', name: 'USDC', decimals: 6, balance: 100, fiatPrice: 1, scaleIsKnown: true },
  tokenLabel: 'Circle USDC',
  arrivingName: 'USDCx',
  network: { id: 'arc-testnet', name: 'Arc Testnet', chainId: 5042002 },
  amount: '10',
  isValidAmount: true,
  evmAddress: '0x1234567890123456789012345678901234567890',
  onAmountChange: jest.fn(),
  onSelectToken: jest.fn(),
  onSelectNetwork: jest.fn(),
  onSwitch: jest.fn(),
  onContinue: jest.fn()
};

beforeEach(() => jest.clearAllMocks());

it('names the source network and Miden output before continuing', () => {
  render(<EvmBridgeDepositForm {...props} />);
  expect(screen.getByTestId('bridge-source-network')).toHaveTextContent('Arc Testnet');
  expect(screen.getByTestId('bridge-destination')).toHaveTextContent('miden');
  expect(screen.getByTestId('bridge-destination')).toHaveTextContent('USDCx');
  fireEvent.click(screen.getByTestId('bridge-source-network'));
  expect(props.onSelectNetwork).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByTestId('send-amount-confirm'));
  expect(props.onContinue).toHaveBeenCalledTimes(1);
});

// The iOS E2E reads the From row with this body to prove the source chain before the amount: "Sepolia" is part of
// "Base Sepolia", so it must read the name alone, not the label or another row.
it("gives the E2E From row read the network's name alone", () => {
  render(
    <div data-page-layer="/bridge/deposit">
      <EvmBridgeDepositForm {...props} network={{ id: 'base-sepolia', name: 'Base Sepolia', chainId: 84532 }} />
    </div>
  );
  // eslint-disable-next-line no-new-func -- runs the driver's script body in this document, as cdp.eval does
  expect(new Function(BRIDGE_SOURCE_NETWORK_JS)()).toBe('Base Sepolia');
});

it('shows the available balance and retains the test-funds warning', () => {
  render(<EvmBridgeDepositForm {...props} />);
  expect(screen.getByTestId('send-token-selector')).toHaveTextContent('available 100');
  expect(screen.getByTestId('bridge-test-funds-warning')).toHaveAttribute('role', 'note');
});

it.each([
  { token: { ...props.token, scaleIsKnown: false } },
  { network: undefined },
  { isValidAmount: false },
  { token: { ...props.token, balance: null } }
])('refuses to continue without a valid amount, known scale, network and balance: %j', override => {
  render(<EvmBridgeDepositForm {...props} {...override} />);
  expect(screen.getByTestId('send-amount-confirm')).toBeDisabled();
});
