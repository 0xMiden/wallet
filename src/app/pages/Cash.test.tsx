import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import Cash from './Cash';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticSelection: jest.fn() }));
jest.mock('lib/i18n/numbers', () => ({ toLocalFormat: (value: string) => value }));
jest.mock('framer-motion', () => ({
  ...jest.requireActual('framer-motion'),
  useReducedMotion: () => true
}));
jest.mock('app/icons/v2', () => ({
  Icon: () => <span />,
  IconName: { Backspace: 'backspace' }
}));

const mockLeavePage = jest.fn();
jest.mock('lib/woozie', () => ({
  ...jest.requireActual('lib/woozie'),
  goBack: () => mockLeavePage()
}));

let mockBackHandler: () => boolean | void;
jest.mock('lib/mobile/useMobileBackHandler', () => ({
  useMobileBackHandler: (handler: () => boolean | void) => {
    mockBackHandler = handler;
  }
}));

const press = (...keys: string[]) => {
  keys.forEach(key => fireEvent.click(screen.getByTestId(`numpad-${key}`)));
};

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: jest.fn() });
});

afterAll(() => {
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});

describe('Cash amount entry', () => {
  it('enters cents, ignores repeated decimal points and excess precision, and deletes', () => {
    render(<Cash action="buy" />);
    press('0', '0', '1', '2', 'decimal', 'decimal', '3', '4', '5');
    expect(screen.getByLabelText('cashPayAmount')).toHaveValue('$12.34');
    press('delete', 'delete', 'delete', 'delete', 'delete', 'delete');
    expect(screen.getByLabelText('cashPayAmount')).toHaveValue('');
    press('decimal', '5');
    expect(screen.getByLabelText('cashPayAmount')).toHaveValue('$0.5');
  });

  it('titles the page by its action and sells with USDCx precision', () => {
    render(<Cash action="sell" />);
    expect(screen.getByText('cashSellingUsdc')).toBeInTheDocument();
    press('decimal', '0', '0', '0', '0', '0', '1', '2');
    expect(screen.getByLabelText('cashSellAmount')).toHaveValue('0.000001');
  });

  it('leaves the page from the amount step back button', () => {
    render(<Cash action="buy" />);
    expect(screen.getByText('cashBuyingUsdc')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('flow-back'));
    expect(mockLeavePage).toHaveBeenCalledTimes(1);
  });

  it('accepts keyboard entry while suppressing the native mobile keyboard', () => {
    render(<Cash action="buy" />);
    const input = screen.getByLabelText('cashPayAmount');
    expect(input).toHaveAttribute('inputmode', 'none');
    fireEvent.change(input, { target: { value: '24.50' } });
    expect(input).toHaveValue('$24.50');
    press('delete');
    expect(input).toHaveValue('$24.5');
  });

  it('bounds integer length', () => {
    render(<Cash action="buy" />);
    press(...Array.from({ length: 15 }, () => '9'));
    expect(screen.getByLabelText('cashPayAmount')).toHaveValue('$99999999999999');
  });

  it('requires a positive amount, opens provider selection, and keeps the draft on back', async () => {
    render(<Cash action="buy" />);
    expect(screen.getByRole('button', { name: 'continue' })).toBeDisabled();
    press('0', 'decimal', '0');
    expect(screen.getByRole('button', { name: 'continue' })).toBeDisabled();
    press('1');
    fireEvent.click(screen.getByRole('button', { name: 'continue' }));
    const stripe = await screen.findByRole('radio', { name: 'Stripe' });
    expect(screen.getByTestId('cash-checkout-amount')).toHaveTextContent('$0.01');
    fireEvent.click(stripe);
    expect(stripe).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: 'Transak' }));
    expect(stripe).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('radio', { name: 'Transak' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByTestId('flow-back'));
    await waitFor(() => expect(screen.getByTestId('cash-amount')).toHaveValue('$0.01'));
  });

  it('carries the sell amount into the preview and handles mobile back one step at a time', async () => {
    render(<Cash action="sell" />);
    expect(mockBackHandler()).toBe(false);
    press('2', 'decimal', '5');
    fireEvent.click(screen.getByRole('button', { name: 'continue' }));
    await screen.findByRole('radio', { name: 'Stripe' });
    expect(screen.getByTestId('cash-checkout-amount')).toHaveTextContent('2.5 USDCx');
    act(() => {
      expect(mockBackHandler()).toBe(true);
    });
    await waitFor(() => expect(screen.getByLabelText('cashSellAmount')).toHaveValue('2.5'));
  });
});
