import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import Cash from './Cash';

// ResizeObserver is not implemented in jsdom. The page observes the sell notification to dock the widget.
class MockResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = MockResizeObserver;

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticSelection: jest.fn() }));
jest.mock('lib/i18n/numbers', () => ({ toLocalFormat: (value: string) => value }));
jest.mock('framer-motion', () => ({
  ...jest.requireActual('framer-motion'),
  useReducedMotion: () => true
}));
jest.mock('app/icons/v2', () => ({
  Icon: () => <span />,
  IconName: { Backspace: 'backspace', Warning: 'warning', ArrowUp: 'arrow-up' }
}));

const EVM_ADDRESS = '0x1111111111111111111111111111111111111111';
let mockAccount: { publicKey: string; evmAddress?: string } = { publicKey: 'miden-pk', evmAddress: EVM_ADDRESS };
const mockSignTransaction = jest.fn();
jest.mock('lib/miden/front', () => ({
  useAccount: () => mockAccount,
  useMidenContext: () => ({ signTransaction: mockSignTransaction })
}));
// The Guardian provider that the bridge-out and the transaction queue get. The test compares it by identity.
jest.mock('lib/miden/front/guardian-sync', () => ({ zustandProvider: { name: 'guardian-provider' } }));
// The sell hook reads the balances of the account. The token check itself is the mock below.
jest.mock('lib/store', () => ({
  useWalletStore: (select: (state: { balances: Record<string, never[]> }) => never[] | undefined) =>
    select({ balances: {} })
}));

let mockIsMobile = false;
let mockIsExtension = false;
jest.mock('lib/platform', () => ({
  ...jest.requireActual('lib/platform'),
  isMobile: () => mockIsMobile,
  isExtension: () => mockIsExtension
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
// True when the page gives the widget the full screen, false when it docks the widget above the notification.
const mockWidgetFullScreen = jest.fn<Promise<void>, [boolean]>();
const mockCloseWidget = jest.fn<Promise<void>, []>();
jest.mock('lib/onramp/transak-webview', () => ({
  openTransakWidget: (input: WidgetInput) => mockOpenWidget(input),
  closeTransakWidget: () => mockCloseWidget(),
  setTransakWidgetRect: (rect: { height: number }) => mockWidgetFullScreen(rect.height === window.innerHeight)
}));

const mockInitiateBuy = jest.fn<
  Promise<string>,
  [string, { orderId: string; fiatAmount: string; tokenSymbol: string }]
>();
const mockStartBackground = jest.fn();
const mockRequestSW = jest.fn();
jest.mock('lib/miden/activity', () => ({
  initiateBuyTransaction: (accountId: string, input: { orderId: string; fiatAmount: string; tokenSymbol: string }) =>
    mockInitiateBuy(accountId, input),
  startBackgroundTransactionProcessing: (...args: object[]) => mockStartBackground(...args),
  requestSWTransactionProcessing: () => mockRequestSW()
}));
jest.mock('lib/onramp/buy-batch', () => ({
  midenAccountIdToHex: (id: string) => `hex:${id}`
}));

type PageDeposit = { address: string; amount: string };
type MockOrder = {
  id: string;
  side: 'sell';
  state: 'checkout' | 'awaiting_signature' | 'signed' | 'relay_sent' | 'deposited' | 'failed' | 'expired' | 'cancelled';
  depositAddress: string | null;
  autoExpiresAt: number | null;
};
const mockReadDeposit = jest.fn<Promise<PageDeposit | null>, [{ signal?: AbortSignal }]>();
const mockKeepWidget = jest.fn<Promise<void>, [string]>();
const mockSettleKeptWidget = jest.fn<Promise<boolean | null>, [string]>();
const mockForgetKeptWidget = jest.fn();
jest.mock('lib/onramp/sell-widget', () => ({
  // Real: the page reads the deposit of the widget event with it.
  depositFromWalletRedirection: jest.requireActual('lib/onramp/sell-widget').depositFromWalletRedirection,
  readDepositFromWidget: (options: { signal?: AbortSignal }) => mockReadDeposit(options),
  keepWidgetForPaidClick: (orderId: string) => mockKeepWidget(orderId),
  settleKeptWidget: (orderId: string) => mockSettleKeptWidget(orderId),
  forgetKeptWidget: () => mockForgetKeptWidget()
}));
const mockGetOrder = jest.fn<Promise<MockOrder>, [string]>();
jest.mock('lib/onramp/buy-api', () => ({
  getOrder: (orderId: string) => mockGetOrder(orderId)
}));
jest.mock('lib/onramp/sell-signer', () => ({
  SELL_RELAY_TOKEN: { address: '0x0c86a754a29714c4fe9c6f1359fa7099ed174c0b', decimals: 18, symbol: 'TRNSK' }
}));

type MockSellToken = { faucetId: string; symbol: string; decimals: number; amount: bigint; evmAmount: bigint };
type MockResolution = { kind: 'ready'; token: MockSellToken } | { kind: 'blocked'; reason: string; symbol: string };
const mockResolveSellToken = jest.fn<Promise<MockResolution>, [{ cryptoAmount: string; balances: object[] }]>();
jest.mock('lib/onramp/sell-token', () => ({
  resolveSellToken: (input: { cryptoAmount: string; balances: object[] }) => mockResolveSellToken(input)
}));

type MockStartFailure =
  | { kind: 'refused'; reason: string }
  | { kind: 'order'; state: 'failed' | 'expired' | 'cancelled'; message: string | null }
  | { kind: 'timeout' }
  | { kind: 'stopped' }
  | { kind: 'bridge'; message: string };
type StartInput = {
  account: { publicKey: string; evmAddress: string };
  orderId: string;
  deposit: PageDeposit;
  depositSource: 'event' | 'page';
  token: MockSellToken;
  guardianProvider: object;
  kickTransactions: () => void;
  isLive?: () => boolean;
};
const mockStartSellOrder = jest.fn<Promise<string>, [StartInput]>();
const mockSetSellPaidClick = jest.fn();
jest.mock('lib/miden/activity/sell-order', () => {
  class MockSellStartError extends Error {
    readonly failure: MockStartFailure;
    constructor(failure: MockStartFailure) {
      super(failure.kind);
      this.failure = failure;
    }
  }
  return {
    SellStartError: MockSellStartError,
    SELL_START_POLL_MS: 5,
    startSellOrder: (input: StartInput) => mockStartSellOrder(input),
    setSellPaidClick: (click: object | null) => mockSetSellPaidClick(click)
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

describe('Cash on the extension', () => {
  afterEach(() => {
    mockIsExtension = false;
  });

  it('does not show the flow', () => {
    mockIsExtension = true;
    const view = render(<Cash action="buy" />);
    expect(screen.queryByTestId('cash-page')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cash-amount')).not.toBeInTheDocument();
    view.unmount();
  });
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
  const { SellStartError } = jest.requireMock<{
    SellStartError: new (failure: MockStartFailure) => Error;
  }>('lib/miden/activity/sell-order');
  const originalBackendUrl = process.env.BACKEND_URL;
  const PAGE_ADDRESS = '0x5A3a5f32490d24Cc420d8A5F9c64F9ccd38F06bB';
  const OTHER_ADDRESS = '0x2222222222222222222222222222222222222222';
  // Far in the future: the card shows the deadline with no warning.
  const EXPIRES_AT = 4_000_000_000;
  const SELL_TOKEN: MockSellToken = {
    faucetId: 'mtst1-trnsk-faucet',
    symbol: 'TRNSK',
    decimals: 8,
    amount: 10n ** 10n,
    evmAmount: 10n ** 20n
  };
  const REDIRECTION = {
    eventName: 'TRANSAK_WALLET_REDIRECTION',
    data: { walletAddress: PAGE_ADDRESS, cryptoAmount: 100 }
  };

  const sellOrder = (overrides: Partial<MockOrder>): MockOrder => ({
    id: 'm',
    side: 'sell',
    state: 'awaiting_signature',
    depositAddress: PAGE_ADDRESS.toLowerCase(),
    autoExpiresAt: EXPIRES_AT,
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

  /** The fallback: the widget reports the new order and draws its deposit page, which the wallet reads. */
  const openOverlay = async () => {
    const view = await openWidget();
    act(() => widgetInput().onEvent?.({ eventName: 'TRANSAK_ORDER_CREATED', data: null }));
    await screen.findByTestId('cash-sell-notification');
    return view;
  };

  /** The usual path: the widget names the deposit in its event, and the wallet closes the widget. */
  const openFromEvent = async () => {
    mockReadDeposit.mockImplementation(() => new Promise(() => undefined));
    const view = await openWidget();
    act(() => widgetInput().onEvent?.(REDIRECTION));
    await screen.findByTestId('cash-sell-notification');
    // The close of the native window reaches the page after the event.
    act(() => widgetInput().onClosed());
    return view;
  };

  const confirmButton = () => screen.getByTestId('cash-sell-confirm');
  const notification = () => screen.getByTestId('cash-sell-notification');
  const startInput = (): StartInput => {
    const call = mockStartSellOrder.mock.calls[0];
    if (!call) throw new Error('startSellOrder was not called');
    return call[0];
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
    mockWidgetFullScreen.mockReset();
    mockWidgetFullScreen.mockResolvedValue(undefined);
    mockCloseWidget.mockReset();
    mockCloseWidget.mockResolvedValue(undefined);
    mockKeepWidget.mockReset();
    mockKeepWidget.mockResolvedValue(undefined);
    mockForgetKeptWidget.mockReset();
    mockSetSellPaidClick.mockReset();
    mockStartBackground.mockReset();
    mockRequestSW.mockReset();
    mockNavigate.mockReset();
    currentOrder = sellOrder({});
    mockGetOrder.mockReset();
    mockGetOrder.mockImplementation(async () => currentOrder);
    mockResolveSellToken.mockReset();
    mockResolveSellToken.mockResolvedValue({ kind: 'ready', token: SELL_TOKEN });
    mockStartSellOrder.mockReset();
    mockStartSellOrder.mockResolvedValue('sell-tx-1');
  });

  afterAll(() => {
    process.env.BACKEND_URL = originalBackendUrl;
    mockIsMobile = false;
  });

  it('closes the widget after its event and shows the approve card, with Confirm off until the backend agrees', async () => {
    let resolveOrder: (order: MockOrder) => void = () => undefined;
    mockGetOrder.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveOrder = resolve;
        })
    );
    const view = await openFromEvent();

    expect(mockCloseWidget).toHaveBeenCalledTimes(1);
    expect(mockReadDeposit).not.toHaveBeenCalled();
    expect(mockGetOrder).toHaveBeenCalledWith('m');
    // The close of the widget does not end the approval.
    expect(screen.getByTestId('cash-sell-deposit-address')).toHaveAttribute('title', PAGE_ADDRESS);
    expect(notification()).toHaveAttribute('data-phase', 'confirm');
    expect(notification()).toHaveTextContent('cashSellSendTitle');
    // The provider list stays, and the notification takes the place of the CTA.
    expect(screen.getByRole('radio', { name: 'Transak' })).toBeInTheDocument();
    expect(screen.queryByTestId('cash-checkout-continue')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cash-sell-test-funding')).not.toBeInTheDocument();
    expect(screen.getByTestId('cash-sell-backend-check')).toHaveTextContent('cashSellBackendChecking');
    expect(confirmButton()).toBeDisabled();

    // The backend writes the address in lower case: the check ignores case.
    await act(async () => resolveOrder(sellOrder({ state: 'checkout' })));
    expect(screen.getByTestId('cash-sell-backend-check')).toHaveTextContent('cashSellBackendVerified');
    await waitFor(() => expect(screen.getByTestId('cash-sell-token-check')).toHaveAttribute('data-state', 'ready'));
    expect(mockResolveSellToken).toHaveBeenCalledWith({ cryptoAmount: '100', balances: [] });
    expect(screen.getByTestId('cash-sell-deadline')).toHaveTextContent('cashSellDeadline');
    expect(screen.queryByTestId('cash-sell-short-of-time')).not.toBeInTheDocument();
    expect(confirmButton()).toBeEnabled();
    view.unmount();
  });

  it('warns and keeps Confirm off when the backend names another address', async () => {
    currentOrder = sellOrder({ depositAddress: OTHER_ADDRESS });
    const view = await openFromEvent();
    await waitFor(() =>
      expect(screen.getByTestId('cash-sell-backend-check')).toHaveTextContent('cashSellBackendMismatch')
    );
    expect(screen.getByRole('alert')).toHaveTextContent('cashSellBackendMismatch');
    expect(confirmButton()).toBeDisabled();
    fireEvent.click(confirmButton());
    expect(mockStartSellOrder).not.toHaveBeenCalled();
    view.unmount();
  });

  const blocks: ReadonlyArray<[string, string]> = [
    ['no-token', 'cashSellBlockedNoToken'],
    ['ambiguous-token', 'cashSellBlockedAmbiguous'],
    ['unknown-scale', 'cashSellBlockedUnknownScale'],
    ['not-registered', 'cashSellBlockedNotRegistered'],
    ['amount', 'cashSellBlockedAmount'],
    ['insufficient-balance', 'cashSellBlockedBalance'],
    ['unavailable', 'cashSellBlockedUnavailable']
  ];
  it.each(blocks)('gives the reason and keeps Confirm off when the token check says %s', async (reason, key) => {
    mockResolveSellToken.mockResolvedValue({ kind: 'blocked', reason, symbol: 'TRNSK' });
    const view = await openFromEvent();
    await waitFor(() => expect(screen.getByTestId('cash-sell-token-check')).toHaveTextContent(key));
    expect(screen.getByTestId('cash-sell-token-check')).toHaveAttribute('role', 'alert');
    await waitFor(() =>
      expect(screen.getByTestId('cash-sell-backend-check')).toHaveTextContent('cashSellBackendVerified')
    );
    expect(confirmButton()).toBeDisabled();
    fireEvent.click(confirmButton());
    expect(mockStartSellOrder).not.toHaveBeenCalled();
    view.unmount();
  });

  it('keeps Confirm off when the token check throws', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockResolveSellToken.mockRejectedValue(new Error('registry'));
    const view = await openFromEvent();
    await waitFor(() =>
      expect(screen.getByTestId('cash-sell-token-check')).toHaveTextContent('cashSellBlockedUnavailable')
    );
    expect(confirmButton()).toBeDisabled();
    view.unmount();
    warn.mockRestore();
  });

  it('warns when the order expires before the bridge can finish', async () => {
    // 10 minutes from now: less than the bridge needs.
    currentOrder = sellOrder({ autoExpiresAt: Math.floor(Date.now() / 1000) + 600 });
    const view = await openFromEvent();
    expect(await screen.findByTestId('cash-sell-short-of-time')).toHaveTextContent('cashSellShortOfTime');
    expect(screen.getByTestId('cash-sell-deadline')).toBeInTheDocument();
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
    expect(screen.queryByTestId('cash-sell-notification')).not.toBeInTheDocument();
    expect(readSignal?.aborted).toBe(false);

    act(() =>
      widgetInput().onEvent?.({
        eventName: 'TRANSAK_WALLET_REDIRECTION',
        data: { walletAddress: PAGE_ADDRESS, cryptoAmount: 100 }
      })
    );
    expect(await screen.findByTestId('cash-sell-deposit-address')).toHaveAttribute('title', PAGE_ADDRESS);
    expect(readSignal?.aborted).toBe(true);
    expect(mockCloseWidget).toHaveBeenCalledTimes(1);
    act(() => widgetInput().onClosed());
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    fireEvent.click(confirmButton());
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/sell-status/sell-tx-1'));
    expect(startInput()).toMatchObject({
      deposit: { address: PAGE_ADDRESS, amount: '100' },
      depositSource: 'event'
    });
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
    expect(await screen.findByTestId('cash-sell-deposit-address')).toHaveAttribute('title', PAGE_ADDRESS);
    expect(mockReadDeposit).not.toHaveBeenCalled();
    // A later order-created event does not start a second run.
    act(() => widgetInput().onEvent?.({ eventName: 'TRANSAK_ORDER_CREATED', data: null }));
    expect(mockReadDeposit).not.toHaveBeenCalled();
    view.unmount();
  });

  it('on Confirm starts the sale one time, kicks the queue and opens the status page', async () => {
    // The start is slow: a second Confirm must find no button.
    let finishStart: (txId: string) => void = () => undefined;
    mockStartSellOrder.mockImplementation(
      input =>
        new Promise(resolve => {
          finishStart = txId => {
            input.kickTransactions();
            resolve(txId);
          };
        })
    );
    const view = await openFromEvent();
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    fireEvent.click(confirmButton());

    expect(notification()).toHaveAttribute('data-phase', 'starting');
    expect(notification()).toHaveTextContent('cashSellStartingTitle');
    expect(screen.queryByTestId('cash-sell-confirm')).not.toBeInTheDocument();
    // Mobile back does not stop a start.
    act(() => {
      expect(mockBackHandler()).toBe(true);
    });
    expect(notification()).toHaveAttribute('data-phase', 'starting');
    expect(mockNavigate).not.toHaveBeenCalled();

    expect(mockStartSellOrder).toHaveBeenCalledTimes(1);
    const input = startInput();
    expect(input).toMatchObject({
      account: { publicKey: 'miden-pk', evmAddress: EVM_ADDRESS },
      orderId: 'm',
      deposit: { address: PAGE_ADDRESS, amount: '100' },
      depositSource: 'event',
      token: SELL_TOKEN
    });
    expect(input.guardianProvider).toEqual({ name: 'guardian-provider' });
    expect(input.isLive?.()).toBe(true);

    await act(async () => finishStart('sell-tx-1'));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/sell-status/sell-tx-1'));
    expect(mockStartBackground).toHaveBeenCalledWith(mockSignTransaction, false, { name: 'guardian-provider' });
    expect(mockRequestSW).not.toHaveBeenCalled();
    // The widget closed after its event, so no widget is kept for a paid click.
    expect(mockKeepWidget).not.toHaveBeenCalled();
    expect(mockSetSellPaidClick).not.toHaveBeenCalled();
    // The overlay is gone and the provider page has its CTA again.
    expect(await screen.findByTestId('cash-checkout-continue')).toBeInTheDocument();
    view.unmount();
  });

  it('does not open the status page when the page closed during the start', async () => {
    let finishStart: (txId: string) => void = () => undefined;
    mockStartSellOrder.mockImplementation(
      () =>
        new Promise(resolve => {
          finishStart = resolve;
        })
    );
    const view = await openFromEvent();
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    fireEvent.click(confirmButton());
    const input = startInput();
    view.unmount();
    expect(input.isLive?.()).toBe(false);
    await act(async () => finishStart('sell-tx-1'));
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('reads the deposit page of a widget that draws it, keeps that widget docked and keeps it for the paid click', async () => {
    const view = await openOverlay();

    expect(mockReadDeposit).toHaveBeenCalledTimes(1);
    expect(mockOpenWidget).toHaveBeenCalledWith(
      expect.objectContaining({ rect: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight } })
    );
    // The widget stays open above the card.
    expect(mockCloseWidget).not.toHaveBeenCalled();
    expect(mockWidgetFullScreen).toHaveBeenLastCalledWith(false);
    expect(screen.getByTestId('cash-sell-deposit-address')).toHaveAttribute('title', PAGE_ADDRESS);

    await waitFor(() => expect(confirmButton()).toBeEnabled());
    fireEvent.click(confirmButton());
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/sell-status/sell-tx-1'));
    expect(startInput()).toMatchObject({ orderId: 'm', depositSource: 'page' });
    expect(mockKeepWidget).toHaveBeenCalledWith('m');
    expect(mockSetSellPaidClick).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('gives the screen to a docked widget again on Cancel', async () => {
    const view = await openOverlay();
    expect(mockWidgetFullScreen).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByTestId('cash-sell-cancel'));
    expect(mockWidgetFullScreen).toHaveBeenLastCalledWith(true);
    expect(await screen.findByRole('radio', { name: 'Transak' })).toBeInTheDocument();
    expect(mockStartSellOrder).not.toHaveBeenCalled();
    view.unmount();
  });

  const startFailures: ReadonlyArray<[string, MockStartFailure, string, string | null]> = [
    ['the signer refuses', { kind: 'refused', reason: 'deposit-address' }, 'cashSellRefused', null],
    [
      'the order expired',
      { kind: 'order', state: 'expired', message: 'Transak expired the order' },
      'cashSellOrderExpired',
      'Transak expired the order'
    ],
    ['the order failed', { kind: 'order', state: 'failed', message: null }, 'cashSellOrderFailed', null],
    ['the order was cancelled', { kind: 'order', state: 'cancelled', message: null }, 'cashSellOrderCancelled', null],
    ['the backend is too slow', { kind: 'timeout' }, 'cashSellTimeout', null],
    [
      'the bridge-out cannot start',
      { kind: 'bridge', message: 'Insufficient balance' },
      'cashSellBridgeNotStarted',
      'Insufficient balance'
    ]
  ];
  it.each(startFailures)('shows why the sale did not start when %s', async (_name, failure, key, detail) => {
    mockStartSellOrder.mockRejectedValue(new SellStartError(failure));
    const view = await openFromEvent();
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    fireEvent.click(confirmButton());

    expect(await screen.findByTestId('cash-sell-error')).toHaveTextContent(key);
    expect(notification()).toHaveAttribute('data-phase', 'failed');
    expect(notification()).toHaveTextContent('cashSellFailedTitle');
    const details = screen.queryAllByTestId('cash-sell-error-detail').map(line => line.textContent);
    expect(details).toEqual(detail === null ? [] : [detail]);
    expect(mockNavigate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('cash-sell-done'));
    expect(await screen.findByTestId('cash-checkout-continue')).toBeInTheDocument();
    view.unmount();
  });

  it('shows the general text for a start that fails with another error', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockStartSellOrder.mockRejectedValue(new Error('vault'));
    const view = await openFromEvent();
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    fireEvent.click(confirmButton());
    expect(await screen.findByTestId('cash-sell-error')).toHaveTextContent('cashSellUnexpected');
    // Mobile back closes a failed start.
    act(() => {
      expect(mockBackHandler()).toBe(true);
    });
    expect(await screen.findByTestId('cash-checkout-continue')).toBeInTheDocument();
    view.unmount();
    warn.mockRestore();
  });

  it('returns to the Transak page on Cancel and on mobile back', async () => {
    const view = await openOverlay();
    mockWidgetFullScreen.mockClear();
    fireEvent.click(screen.getByTestId('cash-sell-cancel'));
    expect(mockWidgetFullScreen).toHaveBeenCalledWith(true);
    expect(await screen.findByRole('radio', { name: 'Transak' })).toBeInTheDocument();
    view.unmount();

    mockOpenWidget.mockClear();
    const second = await openOverlay();
    mockWidgetFullScreen.mockClear();
    act(() => {
      expect(mockBackHandler()).toBe(true);
    });
    expect(mockWidgetFullScreen).toHaveBeenCalledWith(true);
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
    expect(mockWidgetFullScreen).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByTestId('cash-sell-cancel'));
    expect(mockWidgetFullScreen).toHaveBeenLastCalledWith(true);
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
    expect(screen.queryByTestId('cash-sell-notification')).not.toBeInTheDocument();
    view.unmount();
  });
});
