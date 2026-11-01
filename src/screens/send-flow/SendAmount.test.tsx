import React from 'react';

import { act, fireEvent, render, screen, within } from '@testing-library/react';

import {
  publishMockBridgeSnapshot,
  TEST_BRIDGE_CONFIG_SNAPSHOT,
  TEST_MIDEN_USDC_FAUCET
} from 'lib/epoch/testing/bridge-config';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';

import { SendAmount, SendAmountProps } from './SendAmount';
jest.mock('lib/miden/swap/tokens', () => ({
  tokenQuote: () => ({ price: 2, observedAt: Date.now(), change24h: 0, percentageChange24h: 0 })
}));

jest.mock('lib/telemetry/user-visible-error', () => ({ reportUserVisibleError: jest.fn() }));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    // A fiat line names its value and a USDCx amount refusal its amount and network; other keys read as themselves.
    t: (key: string, params?: Record<string, string>) =>
      params?.value ? `${key}:${params.value}` : params?.network ? `${key}:${params.amount}:${params.network}` : key
  })
}));
jest.mock('lib/platform', () => ({
  isMobile: () => true,
  isExtension: () => false,
  isAndroid: () => false,
  isIOS: () => true
}));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));

// This realm's bridge config: the real, unloaded one, or the loaded testnet one a case sets.
let mockBridgeSnapshot: BridgeConfigSnapshot | undefined;
jest.mock('lib/remote-config/runtime', () =>
  jest
    .requireActual<typeof import('lib/epoch/testing/bridge-config')>('lib/epoch/testing/bridge-config')
    .remoteConfigRuntimeMock(() => mockBridgeSnapshot)
);
afterEach(() => {
  mockBridgeSnapshot = undefined;
  mockUseRealAmountInput = false;
});
jest.mock('components/TokenLogo', () => ({
  TokenLogo: ({ faucetId }: { faucetId: string | undefined }) => (
    <span data-testid="token-logo" data-faucet-id={faucetId} />
  )
}));
jest.mock('app/icons/logos/eth.svg', () => ({ ReactComponent: () => <svg /> }));
jest.mock('app/icons/v2', () => ({
  IconName: new Proxy({}, { get: (_t, key) => String(key) }),
  Icon: () => <svg />
}));
jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary' },
  Button: ({ title, variant: _variant, accent, ...rest }: any) => (
    <button type="button" data-accent={accent} {...rest}>
      {title}
    </button>
  )
}));
let mockUseRealAmountInput = false;
jest.mock('components/AmountInput', () => ({
  AmountInput: (props: any) =>
    mockUseRealAmountInput ? (
      React.createElement(
        jest.requireActual<typeof import('components/AmountInput')>('components/AmountInput').AmountInput,
        props
      )
    ) : (
      <div>
        <input
          data-testid={props['data-testid']}
          data-invalid={String(!!props.invalid)}
          value={props.value}
          onChange={e => props.onValueChange(e.target.value)}
        />
        <button
          data-testid="change-localized-amount"
          onClick={() => props.onValueChange('1.5', undefined, { value: '1.5', float: 1.5, formatted: '۱.۵' })}
        />
        <button data-testid="clear-amount" onClick={() => props.onValueChange(undefined)} />
        {props.error && <span data-testid="amount-error">{props.error}</span>}
        {props.secondary}
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
  it('stores the canonical amount when the formatted callback uses Persian digits', () => {
    const props = renderAmount();
    fireEvent.click(screen.getByTestId('change-localized-amount'));
    expect(props.onAmountChange).toHaveBeenCalledWith('1.5');
  });

  it('stores an empty amount when the input is cleared', () => {
    const props = renderAmount({ amount: '1.5' });
    fireEvent.click(screen.getByTestId('clear-amount'));
    expect(props.onAmountChange).toHaveBeenCalledWith('');
  });

  it('keeps a fractional amount editable before a token is selected', () => {
    mockUseRealAmountInput = true;
    renderAmount({ token: undefined });
    const input = screen.getByTestId('send-amount-input');

    fireEvent.change(input, { target: { value: '1.5' } });

    expect(input).toHaveValue('1.5');
  });

  it('names the testnet bridge faucet by its label on the token row, keeping its logo', () => {
    mockBridgeSnapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
    renderAmount({ token: { ...TOKEN, id: TEST_MIDEN_USDC_FAUCET, name: 'USDC' } });

    const selector = screen.getByTestId('send-token-selector');
    expect(selector).toHaveTextContent('Test Epoch USDC');
    expect(within(selector).getByTestId('token-logo')).toHaveAttribute('data-faucet-id', TEST_MIDEN_USDC_FAUCET);
  });

  it('names the bridge faucet by its label once the bridge config publishes, with no new props', () => {
    renderAmount({ token: { ...TOKEN, id: TEST_MIDEN_USDC_FAUCET, name: 'USDC' } });
    expect(screen.getByTestId('send-token-selector')).not.toHaveTextContent('Test Epoch USDC');

    act(() => {
      mockBridgeSnapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
      publishMockBridgeSnapshot();
    });

    expect(screen.getByTestId('send-token-selector')).toHaveTextContent('Test Epoch USDC');
  });

  it('shows the title, back button, and a disabled Confirm until the amount is valid', () => {
    const props = renderAmount();

    expect(screen.getByText('enterAmount')).toBeInTheDocument();
    expect(screen.getByTestId('send-amount-confirm')).toBeDisabled();
    fireEvent.click(screen.getByTestId('flow-back'));
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });

  it('gives Confirm the send flow colour', () => {
    renderAmount();

    expect(screen.getByTestId('send-amount-confirm')).toHaveAttribute('data-accent', 'send');
  });

  it('offers Continue for a valid amount and advances toward review', () => {
    const props = renderAmount({ amount: '1.5', isValidAmount: true });

    expect(screen.getByText('approxFiatValue:$3.00')).toBeInTheDocument();
    const continueButton = screen.getByRole('button', { name: 'continue' });
    expect(continueButton).toBeEnabled();
    fireEvent.click(continueButton);
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('fills Max with the spendable balance rounded down', () => {
    const props = renderAmount();

    expect(screen.getByTestId('send-amount-available')).toHaveTextContent('available 12.3456');
    fireEvent.click(screen.getByTestId('send-amount-max'));
    expect(props.onAmountChange).toHaveBeenCalledWith('12.3456');
  });

  it('fills a percentage shortcut from the spendable balance', () => {
    const onAmountChange = jest.fn();
    renderAmount({ onAmountChange });

    fireEvent.click(screen.getByTestId('send-amount-25'));
    expect(onAmountChange).toHaveBeenCalledWith('3.086419');
  });

  it('fills Max below a stored balance that may have been rounded up past 2^52 base units', () => {
    const props = renderAmount({ token: { ...TOKEN, decimals: 12, balance: 10000.3 } });

    fireEvent.click(screen.getByTestId('send-amount-max'));
    expect(props.onAmountChange).toHaveBeenCalledWith('10000.2999');
  });

  it('keeps Max visible but inert while the caller disables it', () => {
    const props = renderAmount({ maxDisabled: true });

    expect(screen.getByTestId('send-amount-max')).toBeDisabled();
    fireEvent.click(screen.getByTestId('send-amount-max'));
    expect(props.onAmountChange).not.toHaveBeenCalled();
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

  it('says Send is still checking a token it holds back, in the shared warning notice', () => {
    renderAmount({ tokenHeld: true });

    expect(screen.getByTestId('send-amount-held-notice')).toHaveTextContent('sendTokenAvailabilityChecking');
    expect(screen.getByTestId('send-amount-held-notice')).toHaveAttribute('data-tone', 'warning');
  });

  it('shows no held notice while no token is held', () => {
    renderAmount();

    expect(screen.queryByTestId('send-amount-held-notice')).not.toBeInTheDocument();
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

  it('fills the error copy with the values the send form hands it', () => {
    renderAmount({
      amount: '1.5',
      network: 'sepolia',
      error: 'usdcxSendMoreThanPayoutFee',
      errorValues: { amount: '1.5', network: 'Sepolia' }
    });

    expect(screen.getByTestId('amount-error')).toHaveTextContent('usdcxSendMoreThanPayoutFee:1.5:Sepolia');
    expect(screen.getByTestId('send-amount-input')).toHaveAttribute('data-invalid', 'true');
  });

  it('refuses a token whose decimals are unverified', () => {
    renderAmount({ token: { ...TOKEN, scaleIsKnown: false }, amount: '1', isValidAmount: true });

    expect(screen.getByTestId('send-amount-available')).toHaveTextContent('unknownTokenScale');
    expect(screen.getByTestId('send-amount-confirm')).toBeDisabled();
  });

  // The amount step is a PUSHED Navigator step, but it is pushed INSIDE TabLayout, so the docked
  // bar is still drawn over it at `z-60`, down to the screen edge. Dropping the CTA to the bottom
  // here put it UNDER the bar, and every click on it was intercepted by the bar's Activity button:
  // the CTA stayed visible, enabled and stable while e2e clicked at it for 30s (guardian-switch
  // and send-private both time out on `send-amount-confirm`). The cushion has to clear the bar,
  // and only `body[data-hide-navbar]` — the fact that the bar is down — may drop it.
  it('keeps Confirm clear of the docked tab bar', () => {
    renderAmount();

    const footer = screen.getByTestId('send-amount-confirm').parentElement;
    expect(footer?.className).toContain('var(--keyboard-height,0px)');
    expect(footer?.className).not.toContain('pb-4');
    expect(footer?.getAttribute('data-navbar-cushion')).toBe('true');
  });

  describe('an Available figure that changes', () => {
    beforeEach(() => {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })
      });
    });

    afterEach(() => {
      Reflect.deleteProperty(window, 'matchMedia');
    });

    const available = () =>
      screen.getByTestId('send-amount-available').querySelector('.tabular-nums')?.textContent ?? '';
    const amountOf = (text: string) => Number(text.replace(/[^\d.]/g, ''));

    /** The line right after the change, and every text it shows until the count is done. */
    const change = async (from: typeof TOKEN, to: typeof TOKEN) => {
      const props: SendAmountProps = {
        amount: '',
        isValidAmount: false,
        recipientAddress: 'mtst1recipientaddress',
        network: 'miden',
        onAmountChange: jest.fn(),
        onSelectToken: jest.fn(),
        onReceive: jest.fn(),
        onBack: jest.fn(),
        onConfirm: jest.fn()
      };
      const { rerender } = render(<SendAmount {...props} token={from} />);
      const line = screen.getByTestId('send-amount-available');
      const frames: string[] = [];
      const observer = new MutationObserver(() => frames.push(available()));
      observer.observe(line, { characterData: true, childList: true, subtree: true });

      rerender(<SendAmount {...props} token={to} />);
      const first = available();
      frames.push(first);
      await act(() => new Promise(resolve => setTimeout(resolve, 800)));
      observer.disconnect();
      frames.push(available());
      return { first, frames };
    };

    const TOKEN_A = { ...TOKEN, id: 'a', balance: 12000 };

    it("lands on the new token's Available balance instead of counting from the old one", async () => {
      const { first, frames } = await change(TOKEN_A, { ...TOKEN, id: 'b', name: 'ETH', balance: 0.25 });

      expect(first).toBe('available 0.25');
      expect(frames.filter(frame => amountOf(frame) > 0.25)).toEqual([]);
    });

    it('still counts the Available balance when the same token changes', async () => {
      const { frames } = await change(TOKEN_A, { ...TOKEN_A, balance: 15000 });

      expect(frames.some(frame => amountOf(frame) > 12000 && amountOf(frame) < 15000)).toBe(true);
      expect(frames[frames.length - 1]).toBe('available 15000');
    });
  });
});

describe('SendAmount user-visible errors', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.mocked(reportUserVisibleError).mockClear();
    mockUseRealAmountInput = true;
  });

  afterEach(() => {
    mockUseRealAmountInput = false;
    jest.useRealTimers();
  });

  const expectReport = async (id: string, surface: string) => {
    await act(async () => jest.advanceTimersByTimeAsync(999));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
    await act(async () => jest.advanceTimersByTimeAsync(1));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([[id, surface]]);
    await act(async () => jest.advanceTimersByTimeAsync(1000));
    expect(reportUserVisibleError).toHaveBeenCalledTimes(1);
  };

  it.each([
    'invalidAmount',
    'amountMustBeLessThanBalance',
    'feeReserveBlocksSend',
    'usdcxBurnFeeUnavailable',
    'usdcxSendMoreThanPayoutFee'
  ])('reports the displayed %s amount refusal by its key after 1000 ms', async error => {
    const Owner = () => {
      const [amount, setAmount] = React.useState('');
      return (
        <SendAmount {...renderProps()} amount={amount} error={amount ? error : undefined} onAmountChange={setAmount} />
      );
    };
    render(<Owner />);
    fireEvent.change(screen.getByTestId('send-amount-input'), { target: { value: '1.5' } });

    expect(screen.getByText(error)).toBeVisible();
    expect(screen.getByTestId('send-amount-input')).toHaveAttribute('aria-invalid', 'true');
    await expectReport(error, 'field');
  });

  function renderProps(): SendAmountProps {
    return {
      token: TOKEN,
      amount: '',
      isValidAmount: false,
      recipientAddress: 'mtst1recipientaddress',
      network: 'miden',
      onAmountChange: jest.fn(),
      onSelectToken: jest.fn(),
      onReceive: jest.fn(),
      onBack: jest.fn(),
      onConfirm: jest.fn()
    };
  }

  it('forwards the visible burn failure evidence through the real denominated amount field', async () => {
    const evidence = { kind: 'burn_fee', burnFeeFailure: 'dry_run_failed' };
    const props = Object.assign(renderProps(), {
      amount: '1',
      error: 'usdcxBurnFeeUnavailable',
      errorDiagnostics: evidence
    });
    render(<SendAmount {...props} />);
    await act(async () => jest.advanceTimersByTimeAsync(1000));
    expect(reportUserVisibleError).toHaveBeenCalledWith('usdcxBurnFeeUnavailable', 'field', evidence);
  });

  it('reports the fee shortfall notice without marking the amount invalid', async () => {
    renderAmount({ error: 'insufficientFeeAsset' });

    expect(screen.getByTestId('send-fee-notice')).toHaveTextContent('insufficientFeeAsset');
    expect(screen.getByTestId('send-amount-input')).toHaveAttribute('aria-invalid', 'false');
    await expectReport('insufficientFeeAsset', 'notice');
  });

  it('reports a parameterized payout refusal without forwarding its values', async () => {
    renderAmount({
      amount: '1.5',
      error: 'usdcxSendMoreThanPayoutFee',
      errorValues: { amount: '1.5', network: 'Sepolia' }
    });

    expect(screen.getByText('usdcxSendMoreThanPayoutFee:1.5:Sepolia')).toBeVisible();
    await expectReport('usdcxSendMoreThanPayoutFee', 'field');
  });

  it('does not report an invalid amount until its error text becomes visible', async () => {
    const props = { ...renderProps(), error: 'invalidAmount' };
    const { rerender } = render(<SendAmount {...props} />);
    await act(async () => jest.advanceTimersByTimeAsync(1500));
    expect(screen.queryByText('invalidAmount')).not.toBeInTheDocument();
    expect(reportUserVisibleError).not.toHaveBeenCalled();

    rerender(<SendAmount {...props} amount="0" />);
    expect(screen.getByText('invalidAmount')).toBeVisible();
    await expectReport('invalidAmount', 'field');
  });

  it('reports an unknown token scale while confirmation remains blocked', async () => {
    renderAmount({ token: { ...TOKEN, scaleIsKnown: false }, amount: '1', isValidAmount: true });

    expect(screen.getByTestId('send-amount-available')).toHaveTextContent('unknownTokenScale');
    expect(screen.getByTestId('send-amount-confirm')).toBeDisabled();
    await expectReport('unknownTokenScale', 'inline');
  });

  it('does not report the pending burn-fee measurement as an error', async () => {
    renderAmount({ amount: '1.5', error: 'usdcxBurnFeeMeasuring' });
    expect(screen.getByText('usdcxBurnFeeMeasuring')).toBeVisible();
    expect(screen.getByTestId('send-amount-input')).toHaveAttribute('aria-invalid', 'true');

    await act(async () => jest.advanceTimersByTimeAsync(2000));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });

  it('does not report the pending token availability warning as an error', async () => {
    renderAmount({ tokenHeld: true });
    expect(screen.getByTestId('send-amount-held-notice')).toHaveTextContent('sendTokenAvailabilityChecking');

    await act(async () => jest.advanceTimersByTimeAsync(2000));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });
});
