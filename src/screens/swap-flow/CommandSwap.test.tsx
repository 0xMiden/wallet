import React from 'react';

import { userEvent } from '@storybook/test';
import { fireEvent, render, screen } from '@testing-library/react';

import { CommandSwap } from './CommandSwap';
import type { SwapAmountsProps } from './SwapAmounts';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('components/TokenLogo', () => ({ TokenLogo: () => <span aria-hidden="true" /> }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getTestNetworkNameKey: () => 'testnet'
}));
jest.mock('lib/remote-config/use-feature-availability', () => ({
  useBridgeConfigSnapshot: () => jest.requireActual('lib/epoch/testing/bridge-config').TEST_BRIDGE_CONFIG_SNAPSHOT
}));

const offer = { faucetId: 'offer-faucet', symbol: 'AAA', decimals: 8 };
const request = { faucetId: 'request-faucet', symbol: 'BBB', decimals: 2 };
function props(overrides: Partial<SwapAmountsProps> = {}): SwapAmountsProps {
  return {
    offerToken: offer,
    offerBalance: 100,
    offerAmount: '1.12345678',
    onOfferAmountChange: jest.fn(),
    onSelectOfferToken: jest.fn(),
    requestToken: request,
    requestAmount: '2.35',
    onRequestAmountChange: jest.fn(),
    onSelectRequestToken: jest.fn(),
    onSwapDirection: jest.fn(),
    onConfirm: jest.fn(),
    canProceed: true,
    ...overrides
  };
}

it('edits the source only at its real scale and presents the estimated receive as output', () => {
  const onOfferAmountChange = jest.fn();
  render(<CommandSwap {...props({ onOfferAmountChange })} />);
  const input = screen.getByRole('textbox', { name: 'youPay' });
  expect(input).toHaveValue('1.12345678');
  expect(screen.queryByRole('textbox', { name: 'youReceive' })).not.toBeInTheDocument();
  expect(screen.getByTestId('command-swap-receive')).toHaveTextContent('2.35');
  fireEvent.change(input, { target: { value: '1.123456789' } });
  expect(onOfferAmountChange).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: '1.12345670' } });
  expect(onOfferAmountChange).toHaveBeenCalledWith('1.12345670');
});

it('uses one form submission for keyboard Enter and blocks a refused quote', async () => {
  const onConfirm = jest.fn();
  const view = render(<CommandSwap {...props({ onConfirm })} />);
  await userEvent.click(screen.getByRole('textbox', { name: 'youPay' }));
  await userEvent.keyboard('{Enter}');
  expect(onConfirm).toHaveBeenCalledTimes(1);
  view.rerender(<CommandSwap {...props({ onConfirm, canProceed: false })} />);
  await userEvent.click(screen.getByRole('textbox', { name: 'youPay' }));
  await userEvent.keyboard('{Enter}');
  expect(onConfirm).toHaveBeenCalledTimes(1);
});
