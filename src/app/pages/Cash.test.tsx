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
  IconName: { Backspace: 'backspace', Warning: 'warning' }
}));

const EVM_ADDRESS = '0x1111111111111111111111111111111111111111';
let mockAccount: { publicKey: string; evmAddress?: string } = { publicKey: 'miden-pk', evmAddress: EVM_ADDRESS };
jest.mock('lib/miden/front', () => ({ useAccount: () => mockAccount }));

let mockIsMobile = false;
jest.mock('lib/platform', () => ({
  ...jest.requireActual('lib/platform'),
  isMobile: () => mockIsMobile
}));

type WidgetInput = {
  url: string;
  expected: { side: 'buy'; evmAddress: string; fiatAmount: string } | { side: 'sell'; cryptoAmount: string };
  onMismatch: () => void;
  onClosed: () => void;
  onEvent?: (event: { eventName: string; data: { walletAddress?: string; cryptoAmount?: number } | null }) => void;
};
const mockCreateSession = jest.fn();
const mockCreateSellSession = jest.fn();
const mockOpenWidget = jest.fn<Promise<void>, [WidgetInput]>();
jest.mock('lib/onramp/transak-client', () => {
  class MockTransakSessionError extends Error {
    readonly reason: 'request-failed' | 'mismatch';
    constructor(reason: 'request-failed' | 'mismatch') {
      super(reason);
      this.reason = reason;
    }
  }
  return {
    TransakSessionError: MockTransakSessionError,
    createTransakBuySession: (input: object) => mockCreateSession(input),
    createTransakSellSession: (input: object) => mockCreateSellSession(input)
  };
});
jest.mock('lib/onramp/transak-webview', () => ({
  openTransakWidget: (input: WidgetInput) => mockOpenWidget(input)
}));

const mockInitiateBuy = jest.fn<
  Promise<string>,
  [string, { orderId: string; fiatAmount: string; tokenSymbol: string }]
>();
jest.mock('lib/miden/activity', () => ({
  initiateBuyTransaction: (accountId: string, input: { orderId: string; fiatAmount: string; tokenSymbol: string }) =>
    mockInitiateBuy(accountId, input)
}));
jest.mock('lib/onramp/buy-batch', () => ({
  midenAccountIdToHex: (id: string) => `hex:${id}`,
  SELL_RELAY_AMOUNT_DIVISOR: 100n
}));

type PageDeposit = { address: string; amount: string };
type MockOrder = {
  id: string;
  side: 'sell';
  state: 'checkout' | 'awaiting_signature' | 'signed' | 'relay_sent' | 'deposited' | 'failed' | 'expired' | 'cancelled';
  depositAddress: string | null;
  relayTxHash: string | null;
  error: string | null;
  prepare: { depositAddress: string } | null;
};
type SignInput = {
  account: { publicKey: string; evmAddress: string; midenAccountHex: string };
  depositAddress: string;
  cryptoAmount: string;
  order: MockOrder;
};
const mockReadDeposit = jest.fn<Promise<PageDeposit | null>, [{ signal?: AbortSignal }]>();
const mockSetWidgetVisible = jest.fn<Promise<void>, [boolean]>();
const mockClickPaid = jest.fn<Promise<boolean>, []>();
jest.mock('lib/onramp/sell-widget', () => ({
  ...jest.requireActual('lib/onramp/sell-widget'),
  readDepositFromWidget: (options: { signal?: AbortSignal }) => mockReadDeposit(options),
  setWidgetVisible: (visible: boolean) => mockSetWidgetVisible(visible),
  clickPaidButton: () => mockClickPaid()
}));
const mockGetOrder = jest.fn<Promise<MockOrder>, [string]>();
jest.mock('lib/onramp/buy-api', () => ({
  getOrder: (orderId: string) => mockGetOrder(orderId)
}));
const mockSignSell = jest.fn<Promise<string>, [SignInput]>();
jest.mock('lib/onramp/sell-signer', () => {
  class MockSellSignRefusedError extends Error {
    readonly reason: string;
    constructor(reason: string) {
      super(reason);
      this.reason = reason;
    }
  }
  return {
    SellSignRefusedError: MockSellSignRefusedError,
    signSellOrder: (input: SignInput) => mockSignSell(input)
  };
});

const mockLeavePage = jest.fn();
const mockNavigate = jest.fn();
jest.mock('lib/woozie', () => ({
  ...jest.requireActual('lib/woozie'),
  goBack: () => mockLeavePage(),
  navigate: (to: string) => mockNavigate(to)
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
    // The field draws the `$` beside the input, so the value stays bare digits.
    expect(screen.getByLabelText('cashPayAmount')).toHaveValue('12.34');
    expect(screen.getByText('$')).toBeInTheDocument();
    press('delete', 'delete', 'delete', 'delete', 'delete', 'delete');
    expect(screen.getByLabelText('cashPayAmount')).toHaveValue('');
    press('decimal', '5');
    expect(screen.getByLabelText('cashPayAmount')).toHaveValue('0.5');
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
    expect(input).toHaveValue('24.50');
    press('delete');
    expect(input).toHaveValue('24.5');
  });

  it('bounds integer length', () => {
    render(<Cash action="buy" />);
    press(...Array.from({ length: 15 }, () => '9'));
    expect(screen.getByLabelText('cashPayAmount')).toHaveValue('99999999999999');
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
    expect(stripe).toBeDisabled();
    expect(screen.getByText('cashComingSoon')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Transak' }));
    expect(stripe).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('radio', { name: 'Transak' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByTestId('flow-back'));
    await waitFor(() => expect(screen.getByTestId('cash-amount')).toHaveValue('0.01'));
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

describe('Cash provider checkout', () => {
  const { TransakSessionError } = jest.requireMock<{
    TransakSessionError: new (reason: 'request-failed' | 'mismatch') => Error;
  }>('lib/onramp/transak-client');
  const originalBackendUrl = process.env.BACKEND_URL;

  const openProviders = async (action: 'buy' | 'sell' = 'buy') => {
    const view = render(<Cash action={action} />);
    press('1', '2', 'decimal', '5');
    fireEvent.click(screen.getByRole('button', { name: 'continue' }));
    await screen.findByRole('radio', { name: 'Transak' });
    return view;
  };
  const continueButton = () => screen.getByTestId('cash-checkout-continue');
  const widgetInput = (): WidgetInput => {
    const call = mockOpenWidget.mock.calls[0];
    if (!call) throw new Error('openTransakWidget was not called');
    return call[0];
  };

  beforeEach(() => {
    mockIsMobile = true;
    mockAccount = { publicKey: 'miden-pk', evmAddress: EVM_ADDRESS };
    process.env.BACKEND_URL = 'https://backend.test';
    mockCreateSession.mockReset();
    mockCreateSellSession.mockReset();
    mockOpenWidget.mockReset();
    mockCreateSession.mockResolvedValue({ widgetUrl: 'https://global.transak.com/?sessionId=s', partnerOrderId: 'n' });
    mockCreateSellSession.mockResolvedValue({
      widgetUrl: 'https://global.transak.com/?sessionId=sell',
      partnerOrderId: 'm'
    });
    mockOpenWidget.mockResolvedValue(undefined);
    mockInitiateBuy.mockReset();
    mockInitiateBuy.mockResolvedValue('buy-tx-1');
    mockNavigate.mockReset();
  });

  afterAll(() => {
    process.env.BACKEND_URL = originalBackendUrl;
    mockIsMobile = false;
  });

  it('keeps Buy a preview with no CTA off mobile', async () => {
    mockIsMobile = false;
    const view = await openProviders();
    expect(screen.getByText('cashProviderPreview')).toBeInTheDocument();
    expect(screen.queryByTestId('cash-checkout-continue')).not.toBeInTheDocument();
    view.unmount();
  });

  it('keeps Sell a preview with no CTA off mobile', async () => {
    mockIsMobile = false;
    const view = await openProviders('sell');
    expect(screen.getByText('cashProviderPreview')).toBeInTheDocument();
    expect(screen.queryByTestId('cash-checkout-continue')).not.toBeInTheDocument();
    view.unmount();
  });

  it('opens the sell widget with the crypto amount, makes no buy row and stays on the page when it closes', async () => {
    const view = await openProviders('sell');
    fireEvent.click(screen.getByRole('radio', { name: 'Transak' }));
    fireEvent.click(continueButton());
    await waitFor(() => expect(mockOpenWidget).toHaveBeenCalledTimes(1));
    expect(mockCreateSellSession).toHaveBeenCalledWith({
      apiUrl: 'https://backend.test',
      midenAccountPublicKey: 'miden-pk',
      midenAccountHex: 'hex:miden-pk',
      evmAddress: EVM_ADDRESS,
      cryptoAmount: '12.5'
    });
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockInitiateBuy).not.toHaveBeenCalled();
    expect(widgetInput()).toMatchObject({
      url: 'https://global.transak.com/?sessionId=sell',
      expected: { side: 'sell', cryptoAmount: '12.5' }
    });
    act(() => widgetInput().onClosed());
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: 'Transak' })).toBeInTheDocument();
    view.unmount();
  });

  it('explains a sell for an account with no EVM address', async () => {
    mockAccount = { publicKey: 'miden-pk' };
    const view = await openProviders('sell');
    fireEvent.click(screen.getByRole('radio', { name: 'Transak' }));
    expect(screen.getByText('cashNoEvmAddressSell')).toBeInTheDocument();
    expect(continueButton()).toBeDisabled();
    view.unmount();
  });

  it('shows the sell mismatch state when the widget reports an order mismatch', async () => {
    const view = await openProviders('sell');
    fireEvent.click(screen.getByRole('radio', { name: 'Transak' }));
    fireEvent.click(continueButton());
    await waitFor(() => expect(mockOpenWidget).toHaveBeenCalledTimes(1));
    act(() => widgetInput().onMismatch());
    expect(screen.getByTestId('cash-address-mismatch')).toHaveTextContent('cashCheckoutSellMismatch');
    view.unmount();
  });

  it('shows the CTA on mobile Buy, disabled until Transak is chosen', async () => {
    const view = await openProviders();
    expect(screen.queryByText('cashProviderPreview')).not.toBeInTheDocument();
    expect(continueButton()).toHaveTextContent('cashContinueWithProvider');
    expect(continueButton()).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Stripe' })).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: 'Transak' }));
    expect(continueButton()).toBeEnabled();
    view.unmount();
  });

  it('explains and disables the CTA for an account with no EVM address', async () => {
    mockAccount = { publicKey: 'miden-pk' };
    const view = await openProviders();
    fireEvent.click(screen.getByRole('radio', { name: 'Transak' }));
    expect(screen.getByText('cashNoEvmAddress')).toBeInTheDocument();
    expect(continueButton()).toBeDisabled();
    view.unmount();
  });

  it('explains and disables the CTA when the backend URL is not set', async () => {
    process.env.BACKEND_URL = '';
    const view = await openProviders();
    fireEvent.click(screen.getByRole('radio', { name: 'Transak' }));
    expect(screen.getByText('cashBackendMissing')).toBeInTheDocument();
    expect(continueButton()).toBeDisabled();
    view.unmount();
  });

  it('creates a session and opens the widget with the expected address and amount', async () => {
    const view = await openProviders();
    fireEvent.click(screen.getByRole('radio', { name: 'Transak' }));
    fireEvent.click(continueButton());
    await waitFor(() => expect(mockOpenWidget).toHaveBeenCalledTimes(1));
    expect(mockCreateSession).toHaveBeenCalledWith({
      apiUrl: 'https://backend.test',
      midenAccountPublicKey: 'miden-pk',
      midenAccountHex: 'hex:miden-pk',
      evmAddress: EVM_ADDRESS,
      fiatAmount: '12.5'
    });
    expect(widgetInput()).toMatchObject({
      url: 'https://global.transak.com/?sessionId=s',
      expected: { evmAddress: EVM_ADDRESS, fiatAmount: '12.5' }
    });
    view.unmount();
  });

  it('creates the buy row with the partner order id and opens its status page when the widget closes', async () => {
    const view = await openProviders();
    fireEvent.click(screen.getByRole('radio', { name: 'Transak' }));
    fireEvent.click(continueButton());
    await waitFor(() => expect(mockOpenWidget).toHaveBeenCalledTimes(1));
    expect(mockInitiateBuy).toHaveBeenCalledWith('miden-pk', { orderId: 'n', fiatAmount: '12.5', tokenSymbol: 'USDC' });
    const [buyOrder = Infinity] = mockInitiateBuy.mock.invocationCallOrder;
    const [widgetOrder = -Infinity] = mockOpenWidget.mock.invocationCallOrder;
    expect(buyOrder).toBeLessThan(widgetOrder);
    expect(mockNavigate).not.toHaveBeenCalled();
    act(() => widgetInput().onClosed());
    expect(mockNavigate).toHaveBeenCalledWith('/buy-status/buy-tx-1');
    view.unmount();
  });

  it('does not open the status page when the widget closes after an address mismatch', async () => {
    const view = await openProviders();
    fireEvent.click(screen.getByRole('radio', { name: 'Transak' }));
    fireEvent.click(continueButton());
    await waitFor(() => expect(mockOpenWidget).toHaveBeenCalledTimes(1));
    act(() => widgetInput().onMismatch());
    act(() => widgetInput().onClosed());
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.getByTestId('cash-address-mismatch')).toBeInTheDocument();
    view.unmount();
  });

  it('shows the generic error line and does not open the widget when the buy row cannot be made', async () => {
    mockInitiateBuy.mockRejectedValueOnce(new Error('db'));
    const view = await openProviders();
    fireEvent.click(screen.getByRole('radio', { name: 'Transak' }));
    fireEvent.click(continueButton());
    expect(await screen.findByText('cashCheckoutError')).toBeInTheDocument();
    expect(mockOpenWidget).not.toHaveBeenCalled();
    view.unmount();
  });

  it('shows the mismatch line when the session check fails, and lets the user try again', async () => {
    mockCreateSession.mockRejectedValueOnce(new TransakSessionError('mismatch'));
    const view = await openProviders();
    fireEvent.click(screen.getByRole('radio', { name: 'Transak' }));
    fireEvent.click(continueButton());
    expect(await screen.findByText('cashCheckoutMismatch')).toBeInTheDocument();
    expect(mockOpenWidget).not.toHaveBeenCalled();
    fireEvent.click(continueButton());
    await waitFor(() => expect(mockOpenWidget).toHaveBeenCalledTimes(1));
    expect(mockCreateSession).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('cashCheckoutMismatch')).not.toBeInTheDocument();
    view.unmount();
  });

  it('shows the generic error line for any other failure', async () => {
    mockCreateSession.mockRejectedValueOnce(new Error('network'));
    const view = await openProviders();
    fireEvent.click(screen.getByRole('radio', { name: 'Transak' }));
    fireEvent.click(continueButton());
    expect(await screen.findByText('cashCheckoutError')).toBeInTheDocument();
    view.unmount();
  });

  it('replaces the providers with a blocking state when the widget reports an address mismatch', async () => {
    const view = await openProviders();
    fireEvent.click(screen.getByRole('radio', { name: 'Transak' }));
    fireEvent.click(continueButton());
    await waitFor(() => expect(mockOpenWidget).toHaveBeenCalledTimes(1));
    act(() => widgetInput().onMismatch());
    expect(screen.getByTestId('cash-address-mismatch')).toHaveTextContent('cashCheckoutAddressMismatch');
    expect(screen.queryByRole('radio', { name: 'Transak' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('cash-checkout-continue')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('flow-back'));
    await waitFor(() => expect(screen.getByTestId('cash-amount')).toHaveValue('12.5'));
    view.unmount();
  });

  it('ignores a widget callback that arrives after the page closes', async () => {
    const view = await openProviders();
    fireEvent.click(screen.getByRole('radio', { name: 'Transak' }));
    fireEvent.click(continueButton());
    await waitFor(() => expect(mockOpenWidget).toHaveBeenCalledTimes(1));
    view.unmount();
    expect(() => widgetInput().onMismatch()).not.toThrow();
  });
});

describe('Cash sell overlay', () => {
  const { SellSignRefusedError } = jest.requireMock<{
    SellSignRefusedError: new (reason: string) => Error;
  }>('lib/onramp/sell-signer');
  const originalBackendUrl = process.env.BACKEND_URL;
  const PAGE_ADDRESS = '0x5A3a5f32490d24Cc420d8A5F9c64F9ccd38F06bB';
  const OTHER_ADDRESS = '0x2222222222222222222222222222222222222222';
  const RELAY_TX_HASH = `0x${'cd'.repeat(32)}`;
  const BRIDGE_MOCK_MS = 1_500;

  const sellOrder = (overrides: Partial<MockOrder>): MockOrder => ({
    id: 'm',
    side: 'sell',
    state: 'awaiting_signature',
    depositAddress: PAGE_ADDRESS.toLowerCase(),
    relayTxHash: null,
    error: null,
    prepare: { depositAddress: PAGE_ADDRESS },
    ...overrides
  });

  let currentOrder: MockOrder;

  const widgetInput = (): WidgetInput => {
    const call = mockOpenWidget.mock.calls[0];
    if (!call) throw new Error('openTransakWidget was not called');
    return call[0];
  };

  /** Enter 100 USDCx, pick Transak and open the sell widget. */
  const openWidget = async () => {
    const view = render(<Cash action="sell" />);
    press('1', '0', '0');
    fireEvent.click(screen.getByRole('button', { name: 'continue' }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Transak' }));
    fireEvent.click(screen.getByTestId('cash-checkout-continue'));
    await waitFor(() => expect(mockOpenWidget).toHaveBeenCalledTimes(1));
    return view;
  };

  /** Open the sell widget and let it report the new order. */
  const openOverlay = async () => {
    const view = await openWidget();
    act(() => widgetInput().onEvent?.({ eventName: 'TRANSAK_ORDER_CREATED', data: null }));
    await screen.findByTestId('cash-sell-overlay');
    return view;
  };

  const confirmButton = () => screen.getByTestId('cash-sell-confirm');
  const stepState = (step: string) =>
    document.querySelector(`[data-transaction-step="${step}"]`)?.getAttribute('data-state');

  /** Confirm, then run the mock bridge-out wait on fake timers. */
  const confirmAndBridge = async () => {
    jest.useFakeTimers();
    fireEvent.click(confirmButton());
    await act(async () => {
      await jest.advanceTimersByTimeAsync(BRIDGE_MOCK_MS);
    });
    jest.useRealTimers();
  };

  beforeEach(() => {
    mockIsMobile = true;
    mockAccount = { publicKey: 'miden-pk', evmAddress: EVM_ADDRESS };
    process.env.BACKEND_URL = 'https://backend.test';
    mockCreateSellSession.mockReset();
    mockCreateSellSession.mockResolvedValue({
      widgetUrl: 'https://global.transak.com/?sessionId=sell',
      partnerOrderId: 'm'
    });
    mockOpenWidget.mockReset();
    mockOpenWidget.mockResolvedValue(undefined);
    mockReadDeposit.mockReset();
    mockReadDeposit.mockResolvedValue({ address: PAGE_ADDRESS, amount: '100' });
    mockSetWidgetVisible.mockReset();
    mockSetWidgetVisible.mockResolvedValue(undefined);
    mockClickPaid.mockReset();
    mockClickPaid.mockResolvedValue(true);
    currentOrder = sellOrder({});
    mockGetOrder.mockReset();
    mockGetOrder.mockImplementation(async () => currentOrder);
    mockSignSell.mockReset();
    mockSignSell.mockImplementation(async () => {
      currentOrder = sellOrder({ state: 'deposited', relayTxHash: RELAY_TX_HASH });
      return 'signed';
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    process.env.BACKEND_URL = originalBackendUrl;
    mockIsMobile = false;
  });

  it('hides the widget and shows the page values after the order is created, with Confirm off until the backend agrees', async () => {
    let resolveOrder: (order: MockOrder) => void = () => undefined;
    mockGetOrder.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveOrder = resolve;
        })
    );
    const view = await openOverlay();

    expect(mockReadDeposit).toHaveBeenCalledTimes(1);
    expect(mockSetWidgetVisible).toHaveBeenCalledWith(false);
    expect(mockGetOrder).toHaveBeenCalledWith('m');
    expect(screen.getByTestId('cash-sell-deposit-address')).toHaveTextContent(PAGE_ADDRESS);
    expect(screen.getByTestId('cash-sell-summary')).toHaveTextContent('cashSellBridgingOut');
    expect(screen.getByTestId('cash-sell-test-funding')).toHaveTextContent(EVM_ADDRESS);
    expect(screen.getByTestId('cash-sell-backend-check')).toHaveTextContent('cashSellBackendChecking');
    expect(confirmButton()).toBeDisabled();

    // The backend writes the address in lower case: the check ignores case.
    await act(async () => resolveOrder(sellOrder({ state: 'checkout', prepare: null })));
    expect(screen.getByTestId('cash-sell-backend-check')).toHaveTextContent('cashSellBackendVerified');
    expect(confirmButton()).toBeEnabled();
    view.unmount();
  });

  it('warns and keeps Confirm off when the backend names another address', async () => {
    currentOrder = sellOrder({ depositAddress: OTHER_ADDRESS });
    const view = await openOverlay();
    await waitFor(() =>
      expect(screen.getByTestId('cash-sell-backend-check')).toHaveTextContent('cashSellBackendMismatch')
    );
    expect(screen.getByRole('alert')).toHaveTextContent('cashSellBackendMismatch');
    expect(confirmButton()).toBeDisabled();
    fireEvent.click(confirmButton());
    expect(mockSignSell).not.toHaveBeenCalled();
    view.unmount();
  });

  it('takes the deposit from TRANSAK_WALLET_REDIRECTION and stops the page read', async () => {
    // The page never shows its deposit block: the widget sends the event in its place.
    let readSignal: AbortSignal | undefined;
    mockReadDeposit.mockImplementation(
      ({ signal }) =>
        new Promise(resolve => {
          readSignal = signal;
          signal?.addEventListener('abort', () => resolve(null));
        })
    );
    const view = await openWidget();
    act(() => widgetInput().onEvent?.({ eventName: 'TRANSAK_ORDER_CREATED', data: null }));
    await waitFor(() => expect(mockReadDeposit).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('cash-sell-overlay')).not.toBeInTheDocument();
    expect(readSignal?.aborted).toBe(false);

    act(() =>
      widgetInput().onEvent?.({
        eventName: 'TRANSAK_WALLET_REDIRECTION',
        data: { walletAddress: PAGE_ADDRESS, cryptoAmount: 100 }
      })
    );
    expect(await screen.findByTestId('cash-sell-deposit-address')).toHaveTextContent(PAGE_ADDRESS);
    expect(readSignal?.aborted).toBe(true);
    expect(mockSetWidgetVisible).toHaveBeenCalledWith(false);
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    await confirmAndBridge();
    await waitFor(() => expect(screen.getByTestId('cash-sell-progress')).toHaveAttribute('data-phase', 'success'));
    expect(mockSignSell).toHaveBeenCalledWith(
      expect.objectContaining({ depositAddress: PAGE_ADDRESS, cryptoAmount: '100' })
    );
    view.unmount();
  });

  it('starts the overlay from TRANSAK_WALLET_REDIRECTION alone, with no page read', async () => {
    mockReadDeposit.mockImplementation(() => new Promise(() => undefined));
    const view = await openWidget();

    act(() =>
      widgetInput().onEvent?.({
        eventName: 'TRANSAK_WALLET_REDIRECTION',
        data: { walletAddress: PAGE_ADDRESS, cryptoAmount: 100 }
      })
    );
    expect(await screen.findByTestId('cash-sell-deposit-address')).toHaveTextContent(PAGE_ADDRESS);
    expect(mockReadDeposit).not.toHaveBeenCalled();
    // A later order-created event does not start a second run.
    act(() => widgetInput().onEvent?.({ eventName: 'TRANSAK_ORDER_CREATED', data: null }));
    expect(mockReadDeposit).not.toHaveBeenCalled();
    view.unmount();
  });

  it('runs the steps to the deposit, clicks "Yes, I have paid" and shows the widget again', async () => {
    const view = await openOverlay();
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    await confirmAndBridge();

    await waitFor(() => expect(screen.getByTestId('cash-sell-progress')).toHaveAttribute('data-phase', 'success'));
    expect(mockSignSell).toHaveBeenCalledWith({
      account: { publicKey: 'miden-pk', evmAddress: EVM_ADDRESS, midenAccountHex: 'hex:miden-pk' },
      depositAddress: PAGE_ADDRESS,
      cryptoAmount: '100',
      order: expect.objectContaining({ state: 'awaiting_signature' })
    });
    expect(mockClickPaid).toHaveBeenCalledTimes(1);
    expect(mockSetWidgetVisible).toHaveBeenLastCalledWith(true);
    const [clickOrder = Infinity] = mockClickPaid.mock.invocationCallOrder;
    const showOrder = mockSetWidgetVisible.mock.invocationCallOrder.at(-1) ?? -Infinity;
    expect(clickOrder).toBeLessThan(showOrder);
    for (const step of ['bridge', 'prepare', 'relay', 'paid']) {
      expect(stepState(step)).toBe('complete');
    }
    expect(screen.getByTestId('cash-sell-relay-hash')).toHaveTextContent(RELAY_TX_HASH.slice(0, 10));
    expect(screen.queryByTestId('cash-sell-tap-paid')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('cash-sell-done'));
    expect(await screen.findByRole('radio', { name: 'Transak' })).toBeInTheDocument();
    view.unmount();
  });

  it('asks the user to tap "Yes, I have paid" when the wallet finds no such button', async () => {
    mockClickPaid.mockResolvedValue(false);
    const view = await openOverlay();
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    await confirmAndBridge();
    expect(await screen.findByTestId('cash-sell-tap-paid')).toHaveTextContent('cashSellTapPaid');
    view.unmount();
  });

  it('fails the flow with the reason when the signer refuses', async () => {
    mockSignSell.mockRejectedValue(new SellSignRefusedError('deposit-address'));
    const view = await openOverlay();
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    await confirmAndBridge();

    expect(await screen.findByTestId('cash-sell-error')).toHaveTextContent('cashSellRefused');
    expect(screen.getByTestId('cash-sell-progress')).toHaveAttribute('data-phase', 'failed');
    expect(stepState('bridge')).toBe('complete');
    expect(stepState('prepare')).toBe('failed');
    expect(stepState('relay')).toBe('pending');
    expect(mockClickPaid).not.toHaveBeenCalled();

    mockSetWidgetVisible.mockClear();
    fireEvent.click(screen.getByTestId('cash-sell-done'));
    expect(mockSetWidgetVisible).toHaveBeenCalledWith(true);
    expect(await screen.findByRole('radio', { name: 'Transak' })).toBeInTheDocument();
    view.unmount();
  });

  it('shows the backend error when the order ends before the relay is mined', async () => {
    mockSignSell.mockImplementation(async () => {
      currentOrder = sellOrder({ state: 'expired', error: 'Transak expired the order' });
      return 'signed';
    });
    const view = await openOverlay();
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    await confirmAndBridge();
    expect(await screen.findByTestId('cash-sell-error')).toHaveTextContent('cashSellOrderExpired');
    expect(screen.getByTestId('cash-sell-error-detail')).toHaveTextContent('Transak expired the order');
    expect(stepState('relay')).toBe('failed');
    view.unmount();
  });

  it('returns to the Transak page on Cancel and on mobile back', async () => {
    const view = await openOverlay();
    mockSetWidgetVisible.mockClear();
    fireEvent.click(screen.getByTestId('cash-sell-cancel'));
    expect(mockSetWidgetVisible).toHaveBeenCalledWith(true);
    expect(await screen.findByRole('radio', { name: 'Transak' })).toBeInTheDocument();
    view.unmount();

    mockOpenWidget.mockClear();
    const second = await openOverlay();
    mockSetWidgetVisible.mockClear();
    act(() => {
      expect(mockBackHandler()).toBe(true);
    });
    expect(mockSetWidgetVisible).toHaveBeenCalledWith(true);
    expect(await screen.findByRole('radio', { name: 'Transak' })).toBeInTheDocument();
    second.unmount();
  });

  it('explains a page it cannot read and goes back to Transak', async () => {
    mockReadDeposit.mockResolvedValue(null);
    const view = render(<Cash action="sell" />);
    press('1', '0', '0');
    fireEvent.click(screen.getByRole('button', { name: 'continue' }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Transak' }));
    fireEvent.click(screen.getByTestId('cash-checkout-continue'));
    await waitFor(() => expect(mockOpenWidget).toHaveBeenCalledTimes(1));
    act(() => widgetInput().onEvent?.({ eventName: 'TRANSAK_ORDER_CREATED', data: null }));
    expect(await screen.findByTestId('cash-sell-unreadable')).toBeInTheDocument();
    expect(mockSetWidgetVisible).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByTestId('cash-sell-cancel'));
    expect(mockSetWidgetVisible).toHaveBeenLastCalledWith(true);
    expect(await screen.findByRole('radio', { name: 'Transak' })).toBeInTheDocument();
    view.unmount();
  });

  it('starts no overlay for other widget events', async () => {
    const view = render(<Cash action="sell" />);
    press('1', '0', '0');
    fireEvent.click(screen.getByRole('button', { name: 'continue' }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Transak' }));
    fireEvent.click(screen.getByTestId('cash-checkout-continue'));
    await waitFor(() => expect(mockOpenWidget).toHaveBeenCalledTimes(1));
    act(() => widgetInput().onEvent?.({ eventName: 'TRANSAK_WIDGET_OPEN', data: null }));
    expect(mockReadDeposit).not.toHaveBeenCalled();
    expect(screen.queryByTestId('cash-sell-overlay')).not.toBeInTheDocument();
    view.unmount();
  });
});
