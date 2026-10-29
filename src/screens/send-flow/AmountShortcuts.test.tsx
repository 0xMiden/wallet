import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { AmountShortcuts } from './AmountShortcuts';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (key === 'max' ? 'Max' : key),
    i18n: { language: 'de', resolvedLanguage: 'de' }
  })
}));

it('fills quarter, half, three quarters and Max without exceeding the spendable token precision', () => {
  const onAmountChange = jest.fn();
  render(<AmountShortcuts balance={0.00012345} decimals={8} scaleIsKnown onAmountChange={onAmountChange} />);

  fireEvent.click(screen.getByRole('button', { name: '25 %' }));
  expect(onAmountChange).toHaveBeenLastCalledWith('0.00003086');
  fireEvent.click(screen.getByRole('button', { name: '50 %' }));
  expect(onAmountChange).toHaveBeenLastCalledWith('0.00006172');
  fireEvent.click(screen.getByRole('button', { name: '75 %' }));
  expect(onAmountChange).toHaveBeenLastCalledWith('0.00009258');
  fireEvent.click(screen.getByRole('button', { name: 'Max' }));
  expect(onAmountChange).toHaveBeenLastCalledWith('0.00012345');
});

it('does not offer shortcuts before a known spendable balance is available', () => {
  const { rerender } = render(<AmountShortcuts balance={null} decimals={6} scaleIsKnown onAmountChange={jest.fn()} />);
  expect(screen.queryByTestId('amount-shortcuts')).not.toBeInTheDocument();

  rerender(<AmountShortcuts balance={10} decimals={6} scaleIsKnown={false} onAmountChange={jest.fn()} />);
  expect(screen.queryByTestId('amount-shortcuts')).not.toBeInTheDocument();
});
