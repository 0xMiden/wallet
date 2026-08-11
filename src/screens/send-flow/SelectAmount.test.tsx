import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';
import { isMobile } from 'lib/platform';

import { SelectAmount, SelectAmountProps } from './SelectAmount';
import { UIToken } from './types';

// --- i18n: interpolate the `{ value }` option so approxFiatValue is assertable.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && typeof opts === 'object' && 'value' in opts ? `${key}:${opts.value}` : key
  })
}));

// --- Platform / haptics.
jest.mock('lib/platform', () => ({
  isMobile: jest.fn(() => false)
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

// --- Child components: stub out presentational internals, but keep the passed
//     nodes (tokenSelector / label / helper) so SelectAmount's own JSX renders.
jest.mock('components/TokenLogo', () => ({
  TokenLogo: ({ symbol, size }: { symbol: string; size?: string }) => (
    <span data-testid="token-logo" data-symbol={symbol} data-size={size} />
  )
}));

jest.mock('components/Button', () => ({
  Button: ({ title, onClick, disabled }: { title?: string; onClick?: () => void; disabled?: boolean }) => (
    <button data-testid="confirm-btn" onClick={onClick} disabled={disabled}>
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'Primary', Secondary: 'Secondary', Ghost: 'Ghost' }
}));

jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid="icon" data-name={name} />,
  IconName: { ChevronDown: 'chevron-down' }
}));

// The AmountInput mock forwards every prop we care about and exposes buttons
// that invoke `onValueChange` with the different value/values shapes the source
// coalesces over (`values?.formatted || value || ''`).
type OnValueChange = (value: string | undefined, name?: string, values?: { formatted?: string }) => void;

jest.mock('components/AmountInput', () => ({
  AmountInput: ({
    label,
    value,
    error,
    helper,
    tokenSelector,
    showDivider,
    onValueChange,
    'data-testid': dataTestId
  }: {
    label?: React.ReactNode;
    value?: string;
    error?: string;
    helper?: React.ReactNode;
    tokenSelector?: React.ReactNode;
    showDivider?: boolean;
    onValueChange?: OnValueChange;
    'data-testid'?: string;
  }) => (
    <div data-testid="amount-input" data-forwarded-testid={dataTestId} data-show-divider={String(showDivider)}>
      <div data-testid="ai-label">{label}</div>
      {error !== undefined && <div data-testid="ai-error">{error}</div>}
      {helper !== undefined && <div data-testid="ai-helper">{helper}</div>}
      <div data-testid="ai-token-selector">{tokenSelector}</div>
      <div data-testid="ai-value">{value}</div>
      <button data-testid="ai-change-formatted" onClick={() => onValueChange?.('rawF', 'n', { formatted: '987.65' })} />
      <button data-testid="ai-change-value" onClick={() => onValueChange?.('rawVal', 'n', { formatted: '' })} />
      <button data-testid="ai-change-value-novalues" onClick={() => onValueChange?.('rawVal2', 'n', undefined)} />
      <button data-testid="ai-change-empty" onClick={() => onValueChange?.(undefined, 'n', undefined)} />
    </div>
  )
}));

const baseToken = (overrides: Partial<UIToken> = {}): UIToken => ({
  id: 't1',
  name: 'USDC',
  decimals: 6,
  balance: 200,
  fiatPrice: 0.2,
  ...overrides
});

const renderComponent = (props: Partial<SelectAmountProps> = {}) => {
  const defaults: SelectAmountProps = {
    token: baseToken(),
    amount: '10',
    isValidAmount: true,
    onAmountChange: jest.fn(),
    onSelectToken: jest.fn(),
    onConfirm: jest.fn()
  };
  return render(<SelectAmount {...defaults} {...props} />);
};

describe('SelectAmount', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (isMobile as jest.Mock).mockReturnValue(false);
  });

  describe('page variant', () => {
    it('renders the network pill, amount field, token logo, balance helper and confirm CTA', () => {
      renderComponent();

      // Network pill (default showNetworkPill = true).
      expect(screen.getByText('miden')).toBeInTheDocument();

      // Token logo defaults its symbol to token.name.
      const logo = screen.getByTestId('token-logo');
      expect(logo).toHaveAttribute('data-symbol', 'USDC');
      expect(logo).toHaveAttribute('data-size', 'md');

      // Token name chip + chevron icon.
      expect(screen.getByText('USDC')).toBeInTheDocument();
      expect(screen.getByTestId('icon')).toHaveAttribute('data-name', 'chevron-down');
      expect(screen.getByTestId('send-token-selector')).toHaveClass('rounded-full', 'bg-input-bg');

      // Default label + forwarded testid.
      expect(screen.getByTestId('ai-label')).toHaveTextContent('selectAmount');
      expect(screen.getByTestId('amount-input')).toHaveAttribute('data-forwarded-testid', 'send-amount-input');

      // Balance helper: trimmed balance + fiat value (200 * 0.2 = $40.00).
      const helper = screen.getByTestId('ai-helper');
      expect(helper).toHaveTextContent('available 200 USDC');
      expect(helper).toHaveTextContent('approxFiatValue:$40.00');

      // Confirm CTA enabled with default title.
      const confirm = screen.getByTestId('confirm-btn');
      expect(confirm).toHaveTextContent('confirm');
      expect(confirm).not.toBeDisabled();
    });

    it('trims trailing zeros but preserves real decimals in the balance helper', () => {
      renderComponent({ token: baseToken({ balance: 200.5, fiatPrice: 1 }) });
      const helper = screen.getByTestId('ai-helper');
      expect(helper).toHaveTextContent('available 200.5 USDC');
      expect(helper).toHaveTextContent('approxFiatValue:$200.50');
    });

    it('calls onConfirm when the enabled confirm button is clicked', () => {
      const onConfirm = jest.fn();
      renderComponent({ onConfirm });
      fireEvent.click(screen.getByTestId('confirm-btn'));
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it('disables the confirm button when the amount is invalid', () => {
      renderComponent({ isValidAmount: false });
      expect(screen.getByTestId('confirm-btn')).toBeDisabled();
    });

    it('disables the confirm button when there is no token', () => {
      renderComponent({ token: undefined });
      expect(screen.getByTestId('confirm-btn')).toBeDisabled();
    });

    it('disables the confirm button when onConfirm is omitted even if the amount is valid', () => {
      renderComponent({ onConfirm: undefined });
      expect(screen.getByTestId('confirm-btn')).toBeDisabled();
    });

    it('uses the confirmTitle override for the CTA', () => {
      renderComponent({ confirmTitle: 'Swap Now' });
      expect(screen.getByTestId('confirm-btn')).toHaveTextContent('Swap Now');
    });

    it('hides the network pill when showNetworkPill is false', () => {
      renderComponent({ showNetworkPill: false });
      expect(screen.queryByText('miden')).not.toBeInTheDocument();
    });

    it('hides the balance helper when showBalanceHelper is false', () => {
      renderComponent({ showBalanceHelper: false });
      expect(screen.getByTestId('ai-helper')).not.toHaveTextContent('available');
    });

    it('omits the misleading "$0.00" fiat line when the token has no fiat price (swap DEX tokens, #461)', () => {
      renderComponent({ token: baseToken({ balance: 5, fiatPrice: 0 }) });
      const helper = screen.getByTestId('ai-helper');
      expect(helper).toHaveTextContent('available');
      expect(helper).not.toHaveTextContent('approxFiatValue');
    });

    it('shows the available-balance helper even in embedded mode when showBalanceHelper is on (#461)', () => {
      // The swap "You Pay" field is embedded but must still show how much is
      // spendable — previously embedded mode always stripped the helper.
      renderComponent({ embedded: true, token: baseToken({ balance: 200 }) });
      expect(screen.getByTestId('ai-helper')).toHaveTextContent('available');
    });

    it('keeps the balance helper off an embedded field when showBalanceHelper is false (swap "You Receive")', () => {
      renderComponent({ embedded: true, showBalanceHelper: false });
      expect(screen.getByTestId('ai-helper')).not.toHaveTextContent('available');
    });

    it('renders children below the amount field', () => {
      renderComponent({ children: <div data-testid="extra-child">extra</div> });
      expect(screen.getByTestId('extra-child')).toBeInTheDocument();
    });

    it('applies the mobile horizontal padding when isMobile() is true', () => {
      (isMobile as jest.Mock).mockReturnValue(true);
      const { container } = renderComponent();
      expect(container.firstChild).toHaveClass('px-8');
      expect(container.firstChild).not.toHaveClass('px-6');
    });

    it('applies the desktop horizontal padding when isMobile() is false', () => {
      const { container } = renderComponent();
      expect(container.firstChild).toHaveClass('px-6');
    });

    it('uses the default footer padding and honors a footerClassName override', () => {
      const { container: def } = renderComponent();
      expect(def.querySelector('.pb-24')).not.toBeNull();

      const { container: override } = renderComponent({ footerClassName: 'pt-2' });
      expect(override.querySelector('.pt-2')).not.toBeNull();
      expect(override.querySelector('.pb-24')).toBeNull();
    });
  });

  describe('token selector', () => {
    it('shows the divider only after both an amount and token are present', () => {
      const { rerender } = renderComponent({ amount: '', token: undefined });
      expect(screen.getByTestId('amount-input')).toHaveAttribute('data-show-divider', 'false');

      rerender(
        <SelectAmount
          token={baseToken()}
          amount=""
          isValidAmount={false}
          onAmountChange={jest.fn()}
          onSelectToken={jest.fn()}
          onConfirm={jest.fn()}
        />
      );
      expect(screen.getByTestId('amount-input')).toHaveAttribute('data-show-divider', 'false');

      rerender(
        <SelectAmount
          token={baseToken()}
          amount="10"
          isValidAmount
          onAmountChange={jest.fn()}
          onSelectToken={jest.fn()}
          onConfirm={jest.fn()}
        />
      );
      expect(screen.getByTestId('amount-input')).toHaveAttribute('data-show-divider', 'true');
    });

    it('fires haptic feedback and onSelectToken when tapped', () => {
      const onSelectToken = jest.fn();
      renderComponent({ onSelectToken });
      fireEvent.click(screen.getByTestId('send-token-selector'));
      expect(hapticLight).toHaveBeenCalledTimes(1);
      expect(onSelectToken).toHaveBeenCalledTimes(1);
    });

    it('honors the logoSymbol override for the token logo', () => {
      renderComponent({ logoSymbol: 'PSWAP' });
      expect(screen.getByTestId('token-logo')).toHaveAttribute('data-symbol', 'PSWAP');
    });

    it('renders "select a token" text and no logo when no token is selected (page variant)', () => {
      renderComponent({ token: undefined });
      expect(screen.getByText('selectAToken')).toBeInTheDocument();
      expect(screen.queryByTestId('token-logo')).not.toBeInTheDocument();
      // Page variant (not embedded) with no token renders neither logo nor "$".
      expect(screen.getByTestId('ai-token-selector')).not.toHaveTextContent('$');
    });
  });

  describe('amount change coalescing', () => {
    it('prefers the formatted value from the currency-input values object', () => {
      const onAmountChange = jest.fn();
      renderComponent({ onAmountChange });
      fireEvent.click(screen.getByTestId('ai-change-formatted'));
      expect(onAmountChange).toHaveBeenCalledWith('987.65');
    });

    it('falls back to the raw value when formatted is empty', () => {
      const onAmountChange = jest.fn();
      renderComponent({ onAmountChange });
      fireEvent.click(screen.getByTestId('ai-change-value'));
      expect(onAmountChange).toHaveBeenCalledWith('rawVal');
    });

    it('falls back to the raw value when the values object is undefined', () => {
      const onAmountChange = jest.fn();
      renderComponent({ onAmountChange });
      fireEvent.click(screen.getByTestId('ai-change-value-novalues'));
      expect(onAmountChange).toHaveBeenCalledWith('rawVal2');
    });

    it('emits an empty string when neither formatted nor raw value is present', () => {
      const onAmountChange = jest.fn();
      renderComponent({ onAmountChange });
      fireEvent.click(screen.getByTestId('ai-change-empty'));
      expect(onAmountChange).toHaveBeenCalledWith('');
    });
  });

  describe('label and error', () => {
    it('renders the label override in place of the default', () => {
      renderComponent({ label: 'You Pay' });
      expect(screen.getByTestId('ai-label')).toHaveTextContent('You Pay');
      expect(screen.getByTestId('ai-label')).not.toHaveTextContent('selectAmount');
    });

    it('translates and renders the error when present', () => {
      renderComponent({ error: 'amountTooHigh' });
      expect(screen.getByTestId('ai-error')).toHaveTextContent('amountTooHigh');
    });

    it('renders no error row when error is undefined', () => {
      renderComponent({ error: undefined });
      expect(screen.queryByTestId('ai-error')).not.toBeInTheDocument();
    });
  });

  describe('embedded variant', () => {
    it('renders only the amount field (no chrome) with a token', () => {
      renderComponent({ embedded: true });
      expect(screen.getByTestId('amount-input')).toBeInTheDocument();
      expect(screen.getByTestId('token-logo')).toBeInTheDocument();
      // No network pill / confirm button (embedded strips the chrome), but the
      // available-balance helper now shows — it's controlled by showBalanceHelper,
      // not by embedded (#461).
      expect(screen.queryByText('miden')).not.toBeInTheDocument();
      expect(screen.queryByTestId('confirm-btn')).not.toBeInTheDocument();
      expect(screen.getByTestId('ai-helper')).toHaveTextContent('available');
    });

    it('renders the "$" placeholder chip when embedded with no token', () => {
      renderComponent({ embedded: true, token: undefined });
      expect(screen.getByTestId('ai-token-selector')).toHaveTextContent('$');
      expect(screen.getByText('selectAToken')).toBeInTheDocument();
      expect(screen.queryByTestId('token-logo')).not.toBeInTheDocument();
      expect(screen.queryByTestId('confirm-btn')).not.toBeInTheDocument();
    });

    it('ignores children in the embedded variant', () => {
      renderComponent({ embedded: true, children: <div data-testid="extra-child">extra</div> });
      expect(screen.queryByTestId('extra-child')).not.toBeInTheDocument();
    });
  });
});
