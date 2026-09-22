import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { SendAmount, SendAmountProps } from './SendAmount';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params?.value ? `${key}:${params.value}` : key)
  })
}));
jest.mock('lib/platform', () => ({
  isMobile: () => true,
  isExtension: () => false,
  isAndroid: () => false,
  isIOS: () => true
}));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('components/TokenLogo', () => ({
  TokenLogo: ({ symbol }: { symbol: string }) => <span>{symbol}-logo</span>
}));
jest.mock('app/icons/logos/eth.svg', () => ({ ReactComponent: () => <svg /> }));
jest.mock('app/icons/v2', () => ({
  IconName: new Proxy({}, { get: (_t, key) => String(key) }),
  Icon: () => <svg />
}));
jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary' },
  Button: ({ title, variant: _variant, ...rest }: any) => (
    <button type="button" {...rest}>
      {title}
    </button>
  )
}));
jest.mock('components/AmountInput', () => ({
  AmountInput: (props: any) => (
    <div>
      <input
        data-testid={props['data-testid']}
        data-invalid={String(!!props.invalid)}
        value={props.value}
        onChange={e => props.onValueChange(e.target.value)}
      />
      {props.error && <span data-testid="amount-error">{props.error}</span>}
      {props.helper}
    </div>
  )
}));
jest.mock('./bridge-networks', () => ({
  getBridgeNetwork: (id: string) => (id === 'sepolia' ? { id: 'sepolia', name: 'Sepolia', chainId: 1 } : undefined)
}));

const TOKEN = { id: 't', name: 'MIDEN', decimals: 6, balance: 12.345678, fiatPrice: 2, scaleIsKnown: true };

function renderAmount(overrides: Partial<SendAmountProps> = {}) {
  const props: SendAmountProps = {
    token: TOKEN,
    amount: '',
    isValidAmount: false,
    recipientAddress: 'mtst1recipientaddress',
    network: 'miden',
    onAmountChange: jest.fn(),
    onSelectToken: jest.fn(),
    onReceive: jest.fn(),
    onBack: jest.fn(),
    onConfirm: jest.fn(),
    ...overrides
  };
  render(<SendAmount {...props} />);
  return props;
}

describe('SendAmount', () => {
  it('shows the title, back button, and a disabled Confirm until the amount is valid', () => {
    const props = renderAmount();

    expect(screen.getByText('enterAmount')).toBeInTheDocument();
    expect(screen.getByTestId('send-amount-confirm')).toBeDisabled();
    fireEvent.click(screen.getByTestId('flow-back'));
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });

  it('enables Confirm for a valid amount and shows its fiat value', () => {
    const props = renderAmount({ amount: '1.5', isValidAmount: true });

    expect(screen.getByText('approxFiatValue:$3.00')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('send-amount-confirm'));
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('fills Max with the spendable balance rounded down', () => {
    const props = renderAmount();

    expect(screen.getByTestId('send-amount-available')).toHaveTextContent('available 12.3456');
    fireEvent.click(screen.getByTestId('send-amount-max'));
    expect(props.onAmountChange).toHaveBeenCalledWith('12.3456');
  });

  it('opens the token picker from the token row', () => {
    const props = renderAmount({ token: undefined });

    expect(screen.getByText('selectAToken')).toBeInTheDocument();
    expect(screen.queryByTestId('send-amount-max')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('send-token-selector'));
    expect(props.onSelectToken).toHaveBeenCalledTimes(1);
  });

  it('shows the contact name or the shortened address, with its network', () => {
    renderAmount({ recipientName: 'Alice', network: 'sepolia' });

    expect(screen.getByTestId('send-amount-recipient')).toHaveTextContent('Alice');
    expect(screen.getByText('Sepolia')).toBeInTheDocument();
  });

  it('turns a fee shortfall into a notice with a Receive link, leaving the amount unmarked', () => {
    const props = renderAmount({ error: 'insufficientFeeAsset' });

    expect(screen.getByTestId('send-fee-notice')).toHaveTextContent('insufficientFeeAsset');
    expect(screen.getByTestId('send-fee-notice')).toHaveClass('bg-fill', 'rounded-2xl');
    expect(screen.getByTestId('send-fee-notice')).not.toHaveClass('border');
    expect(screen.getByTestId('send-amount-input')).toHaveAttribute('data-invalid', 'false');
    fireEvent.click(screen.getByTestId('send-fee-notice-receive'));
    expect(props.onReceive).toHaveBeenCalledTimes(1);
  });

  it('draws Max and the Receive link in the Send ink, never the bare brand colour', () => {
    renderAmount({ error: 'insufficientFeeAsset' });

    // The brand #607c92 is 3.85:1 on fill: text in the Send colour takes its 4.5:1 ink.
    expect(screen.getByTestId('send-amount-max')).toHaveClass('text-accent-send-ink');
    expect(screen.getByTestId('send-fee-notice-receive')).toHaveClass('text-accent-send-ink');
    expect(screen.getByTestId('send-amount-max')).not.toHaveClass('text-accent-send');
  });

  it('does not mark an empty field as an invalid amount', () => {
    renderAmount({ amount: '', error: 'invalidAmount' });
    expect(screen.queryByTestId('amount-error')).not.toBeInTheDocument();
  });

  it('shows an over-balance error on the amount', () => {
    renderAmount({ amount: '99', error: 'amountMustBeLessThanBalance' });

    expect(screen.getByTestId('amount-error')).toHaveTextContent('amountMustBeLessThanBalance');
    expect(screen.getByTestId('send-amount-input')).toHaveAttribute('data-invalid', 'true');
  });

  it('refuses a token whose decimals are unverified', () => {
    renderAmount({ token: { ...TOKEN, scaleIsKnown: false }, amount: '1', isValidAmount: true });

    expect(screen.getByTestId('send-amount-available')).toHaveTextContent('unknownTokenScale');
    expect(screen.getByTestId('send-amount-confirm')).toBeDisabled();
  });
});
