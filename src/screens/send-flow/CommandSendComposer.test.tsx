import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { CommandSendComposer } from './CommandSendComposer';
import type { SelectRecipientProps } from './SelectRecipient';
import type { SendAmountProps } from './SendAmount';

jest.mock('./SelectRecipient', () => ({
  SelectRecipient: ({ address, onAddressChange }: SelectRecipientProps) => (
    <textarea aria-label="Recipient" value={address} onChange={onAddressChange} />
  )
}));
jest.mock('./SendAmount', () => ({
  SendAmount: ({ amount, onAmountChange }: SendAmountProps) => (
    <input aria-label="Amount" value={amount} onChange={event => onAmountChange(event.target.value)} />
  )
}));

const token = { id: 'tok1', name: 'MDN', decimals: 6, balance: 500, fiatPrice: 1, scaleIsKnown: true };
const recipient = {
  address: '0xrecipient',
  isValidAddress: true,
  chain: 'miden' as const,
  network: 'miden' as const,
  onAddressBook: jest.fn(),
  onSelectNetwork: jest.fn()
};
const amount: SendAmountProps = {
  token,
  amount: '333.123456',
  isValidAmount: true,
  recipientAddress: recipient.address,
  onAmountChange: jest.fn(),
  onSelectToken: jest.fn(),
  onReceive: jest.fn(),
  onBack: jest.fn(),
  onConfirm: jest.fn()
};

it('presents a direct recipient and one editable amount, using the controller review callback once', () => {
  const onRecipientChange = jest.fn();
  const onReview = jest.fn();
  render(
    <CommandSendComposer
      recipient={recipient}
      onRecipientChange={onRecipientChange}
      amount={amount}
      onReview={onReview}
      route={null}
    />
  );
  expect(screen.getAllByRole('textbox')).toHaveLength(2);
  fireEvent.change(screen.getByRole('textbox', { name: 'Recipient' }), { target: { value: '0xnew' } });
  expect(onRecipientChange).toHaveBeenCalledWith('0xnew');
  fireEvent.change(screen.getByRole('textbox', { name: 'Amount' }), { target: { value: '7.123456' } });
  expect(amount.onAmountChange).toHaveBeenCalledWith('7.123456');
  fireEvent.click(screen.getByTestId('command-send-review'));
  expect(onReview).toHaveBeenCalledTimes(1);
});

it('refuses review while the selected bridge route is unavailable, without losing the input', () => {
  const onReview = jest.fn();
  render(
    <CommandSendComposer
      recipient={recipient}
      onRecipientChange={jest.fn()}
      amount={amount}
      onReview={onReview}
      routeBlocked
      route={<div>Route unavailable</div>}
    />
  );
  expect(screen.getByTestId('command-send-review')).toBeDisabled();
  fireEvent.click(screen.getByTestId('command-send-review'));
  expect(onReview).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: 'Amount' })).toHaveValue('333.123456');
});

it('refuses review for a wrong-network recipient or an unknown-scale token', () => {
  const onReview = jest.fn();
  const { rerender } = render(
    <CommandSendComposer
      recipient={{ ...recipient, chain: 'ethereum', network: undefined }}
      onRecipientChange={jest.fn()}
      amount={amount}
      onReview={onReview}
      route={null}
    />
  );
  expect(screen.getByTestId('command-send-review')).toBeDisabled();
  rerender(
    <CommandSendComposer
      recipient={recipient}
      onRecipientChange={jest.fn()}
      amount={{ ...amount, token: { ...token, scaleIsKnown: false } }}
      onReview={onReview}
      route={null}
    />
  );
  expect(screen.getByTestId('command-send-review')).toBeDisabled();
  expect(onReview).not.toHaveBeenCalled();
});
