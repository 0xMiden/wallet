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
  expected: { evmAddress: string; fiatAmount: string };
  onMismatch: () => void;
  onClosed: () => void;
};
const mockCreateSession = jest.fn();
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
    createTransakBuySession: (input: object) => mockCreateSession(input)
  };
});
jest.mock('lib/onramp/transak-webview', () => ({
  openTransakWidget: (input: WidgetInput) => mockOpenWidget(input)
}));

const mockInitiateBuy = jest.fn<Promise<string>, [string, { orderId: string; fiatAmount: string; tokenSymbol: string }]>();
jest.mock('lib/miden/activity', () => ({
  initiateBuyTransaction: (accountId: string, input: { orderId: string; fiatAmount: string; tokenSymbol: string }) =>
    mockInitiateBuy(accountId, input)
}));
jest.mock('lib/onramp/buy-batch', () => ({
  midenAccountIdToHex: (id: string) => `hex:${id}`
}));

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
    expect(stripe).toBeDisabled();
    expect(screen.getByText('cashComingSoon')).toBeInTheDocument();
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
    mockOpenWidget.mockReset();
    mockCreateSession.mockResolvedValue({ widgetUrl: 'https://global.transak.com/?sessionId=s', partnerOrderId: 'n' });
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

  it('keeps Sell a preview on mobile', async () => {
    const view = await openProviders('sell');
    expect(screen.getByText('cashProviderPreview')).toBeInTheDocument();
    expect(screen.queryByTestId('cash-checkout-continue')).not.toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByTestId('cash-amount')).toHaveValue('$12.5'));
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
