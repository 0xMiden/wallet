import React from 'react';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { IOneClickTrackingData, ITransaction } from 'lib/miden/db/types';
import type { WalletPaymentLink } from 'lib/one-click/payment-links';
import { isExtension, isMobile } from 'lib/platform';

import { NearIntentsDepositPage } from './NearIntentsDepositPage';
import { NEAR_TEST_DEPOSIT_ADDRESS, nearRowFixture, nearTrackingFixture } from './testing';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key}:${JSON.stringify(params)}` : key)
  })
}));
jest.mock('lib/telemetry/use-user-visible-error', () => ({ useUserVisibleError: jest.fn() }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticSelection: jest.fn() }));
jest.mock('@capacitor/clipboard', () => ({ Clipboard: { write: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('@capacitor/app', () => ({
  App: { addListener: jest.fn(() => Promise.resolve({ remove: jest.fn() })) }
}));
jest.mock('components/TokenLogo', () => ({
  TokenLogo: ({ faucetId }: { faucetId: string | undefined }) => <span data-testid={`logo-${faucetId}`} />
}));
jest.mock('components/QRCode', () => ({
  QRCode: ({ address }: { address: string }) => <span data-testid="qr" data-value={address} />
}));
jest.mock('screens/generating-transaction/components', () => ({
  TransactionHeroIcon: ({ state }: { state: string }) => <span data-testid={`hero-${state}`} />
}));
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>
}));

// Read at module load by some imports, so the factory cannot close over a test variable.
jest.mock('lib/platform', () => ({
  ...jest.requireActual('lib/platform'),
  isMobile: jest.fn(() => true),
  isExtension: jest.fn(() => false)
}));
const mockPlatform = {
  set mobile(value: boolean) {
    jest.mocked(isMobile).mockReturnValue(value);
  },
  set extension(value: boolean) {
    jest.mocked(isExtension).mockReturnValue(value);
  }
};

const mockAvailableWallets = jest.fn<Promise<string[]>, []>();
const mockOpenWalletPayment = jest.fn<Promise<boolean>, [WalletPaymentLink, number | undefined]>();
jest.mock('lib/mobile/wallet-payments', () => ({
  availablePaymentWallets: () => mockAvailableWallets(),
  openWalletPayment: (link: WalletPaymentLink, deadline?: number) => mockOpenWalletPayment(link, deadline)
}));

const mockBack = jest.fn();
jest.mock('app/hooks/useBackWithFallback', () => ({ useBackWithFallback: () => mockBack }));

const mockNavigate = jest.fn();
jest.mock('lib/woozie', () => ({
  ...jest.requireActual('lib/woozie'),
  navigate: (path: string) => mockNavigate(path),
  Redirect: ({ to }: { to: string }) => <div data-testid="redirect">{to}</div>
}));

let mockRowState: { row?: ITransaction; loaded: boolean } = { loaded: false };
jest.mock('screens/generating-transaction/useTransactionRow', () => ({
  useTransactionRow: () => mockRowState
}));

const NOW = Date.parse('2026-11-10T14:27:08Z');
/** USDC on Ethereum with its contract: a wallet payment link needs the token contract. */
const USDC_WITH_CONTRACT = {
  ...nearTrackingFixture().originAsset,
  contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
};

const showRow = (overrides: Partial<IOneClickTrackingData> = {}) => {
  mockRowState = { loaded: true, row: nearRowFixture(nearTrackingFixture(overrides)) };
};

const renderPage = () => render(<NearIntentsDepositPage rowId="row-1" />);

/** Lets the installed-wallet read settle. */
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  // The phone layout without the native wallet read; the wallet tests turn mobile on.
  mockPlatform.mobile = false;
  mockPlatform.extension = false;
  mockAvailableWallets.mockResolvedValue([]);
  mockOpenWalletPayment.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  jest.clearAllMocks();
});

describe('NearIntentsDepositPage while the address waits', () => {
  it('shows the mobile address view with the quote, the address, the details and the countdown in the strip', () => {
    showRow();
    renderPage();

    expect(screen.getByText('depositFlowDetailsTitle')).toBeInTheDocument();
    expect(screen.getByTestId('deposit-address-amount')).toHaveTextContent('46');
    expect(screen.getByText('depositFlowTokenOnNetwork:{"token":"USDC","network":"Ethereum"}')).toBeInTheDocument();
    expect(screen.getByTestId('deposit-address-receive')).toHaveTextContent('45.91 USDCx');
    expect(screen.getByTestId('deposit-address-lines')).toHaveTextContent(NEAR_TEST_DEPOSIT_ADDRESS);
    const facts = screen.getByTestId('deposit-address-facts');
    expect(facts).toHaveTextContent('bridgeRouteNearIntents');
    expect(facts).toHaveTextContent('nearIntentsTimeEstimate:{"minutes":2}');
    // 45.99 USD in, 45.91 USD out: an 8 cent fee.
    expect(facts).toHaveTextContent('$0.08');
    expect(screen.getByTestId('deposit-address-waiting-body')).toHaveTextContent(
      'depositFlowExpiringBody:{"countdown":"4:52"}'
    );
    expect(screen.queryByTestId('deposit-address-memo')).not.toBeInTheDocument();
    // The end-to-end suites read the phase and the full address from the page box.
    expect(screen.getByTestId('near-intents-deposit-page')).toHaveAttribute('data-phase', 'depositing');
    expect(screen.getByTestId('near-intents-deposit-page')).toHaveAttribute(
      'data-deposit-address',
      NEAR_TEST_DEPOSIT_ADDRESS
    );
    // No wallet on the phone takes the deposit: no Open wallet action.
    expect(screen.queryByTestId('deposit-address-open-wallet')).not.toBeInTheDocument();
  });

  it('counts down each second and stops at zero, then shows the expiry', () => {
    showRow();
    renderPage();
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(screen.getByTestId('deposit-address-waiting-body')).toHaveTextContent('"countdown":"4:50"');

    act(() => {
      jest.advanceTimersByTime(5 * 60_000);
    });
    expect(screen.getByTestId('deposit-address-failed')).toHaveTextContent('nearIntentsStatusExpired');
    expect(screen.getByTestId('deposit-address-failed')).toHaveTextContent('depositFlowNearExpiredBody');
    expect(screen.queryByTestId('deposit-address-block')).not.toBeInTheDocument();
    expect(screen.queryByTestId('deposit-address-copy')).not.toBeInTheDocument();
    expect(screen.queryByTestId('deposit-address-waiting')).not.toBeInTheDocument();
  });

  it('shows the memo in the details card, with its copy and warning', () => {
    showRow({ depositMemo: '123456' });
    renderPage();
    expect(screen.getByTestId('deposit-address-memo')).toHaveTextContent('nearIntentsDepositMemo');
    expect(screen.getByTestId('deposit-address-memo-copy')).toHaveTextContent('123456');
    expect(screen.getByTestId('deposit-address-memo-warning')).toHaveTextContent('nearIntentsMemoWarning');
  });

  it('shows the extension view: QR card, copy pill and the "Address expires in" row', () => {
    mockPlatform.extension = true;
    showRow();
    renderPage();
    expect(screen.getByText('depositFlowDepositTokenTitle:{"token":"USDC"}')).toBeInTheDocument();
    expect(screen.getByTestId('qr')).toHaveAttribute('data-value', NEAR_TEST_DEPOSIT_ADDRESS);
    expect(screen.getByTestId('deposit-address-expiry')).toHaveTextContent('depositFlowAddressExpiresIn');
    expect(screen.getByTestId('deposit-address-expiry')).toHaveTextContent('4:52');
    // The address is the provider's, not the wallet's own EVM address.
    expect(screen.getByTestId('deposit-address-facts')).not.toHaveTextContent('depositFlowYourEvmAddress');
  });

  it('opens the QR sheet with the deposit address', () => {
    showRow();
    renderPage();
    fireEvent.click(screen.getByTestId('deposit-address-qr'));
    expect(screen.getByTestId('deposit-qr-sheet')).toBeInTheDocument();
    expect(screen.getByTestId('qr')).toHaveAttribute('data-value', NEAR_TEST_DEPOSIT_ADDRESS);
  });

  it('offers the installed wallets and opens one with the deadline', async () => {
    mockPlatform.mobile = true;
    mockAvailableWallets.mockResolvedValue(['metamask', 'trust']);
    showRow({ originAsset: USDC_WITH_CONTRACT });
    renderPage();
    await flush();

    fireEvent.click(screen.getByTestId('deposit-address-open-wallet'));
    expect(screen.getByTestId('deposit-open-wallet-metamask')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByTestId('deposit-open-wallet-metamask'));
    });
    expect(mockOpenWalletPayment).toHaveBeenCalledWith(
      expect.objectContaining({ wallet: 'metamask' }),
      Date.parse('2026-11-10T14:32:00Z')
    );
  });

  it('opens no wallet once the deadline passed before the tap', async () => {
    mockPlatform.mobile = true;
    mockAvailableWallets.mockResolvedValue(['metamask']);
    showRow({ originAsset: USDC_WITH_CONTRACT });
    renderPage();
    await flush();
    fireEvent.click(screen.getByTestId('deposit-address-open-wallet'));
    // The clock moves past the deadline, and the page has not rendered again yet.
    jest.setSystemTime(Date.parse('2026-11-10T14:33:00Z'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('deposit-open-wallet-metamask'));
    });
    expect(mockOpenWalletPayment).not.toHaveBeenCalled();
    expect(screen.getByTestId('deposit-open-wallet-failed')).toBeInTheDocument();
  });

  it('asks for the rest of an incomplete deposit, with the amount 1Click saw', () => {
    showRow({
      phase: 'incomplete-deposit',
      statusResponse: {
        correlationId: 'c',
        quoteResponse: nearTrackingFixture().quote,
        status: 'INCOMPLETE_DEPOSIT',
        updatedAt: '2026-11-10T14:27:00Z',
        swapDetails: {
          intentHashes: [],
          nearTxHashes: [],
          originChainTxHashes: [],
          destinationChainTxHashes: [],
          depositedAmount: '20000000'
        }
      }
    });
    renderPage();
    const notice = screen.getByTestId('deposit-address-partial');
    expect(notice).toHaveTextContent('depositFlowPartialTitle:{"received":"20 USDC","expected":"46 USDC"}');
    expect(notice).toHaveTextContent('depositFlowPartialRestBody');
    expect(screen.queryByTestId('deposit-address-partial-action')).not.toBeInTheDocument();
  });

  it('goes back and closes to Home from the header', () => {
    showRow();
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(mockBack).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });
});

describe('NearIntentsDepositPage after the address', () => {
  it('shows the expiry for a row the tracker marked expired', () => {
    showRow({ phase: 'expired' });
    renderPage();
    expect(screen.getByTestId('deposit-address-failed')).toHaveTextContent('nearIntentsStatusExpired');
    expect(screen.queryByTestId('deposit-address-block')).not.toBeInTheDocument();
  });

  it.each([
    ['known-deposit-tx', ['now', 'wait', 'wait']],
    ['processing', ['done', 'now', 'wait']],
    ['arriving', ['done', 'done', 'now']]
  ] as const)('shows the %s phase as the processing steps %j', (phase, states) => {
    showRow({ phase });
    renderPage();
    expect(screen.getByText('transactionProcessingHeader')).toBeInTheDocument();
    expect(screen.getByTestId('deposit-badge-sent')).toHaveTextContent('46 USDC');
    expect(screen.getByTestId('deposit-badge-received')).toHaveTextContent('45.91 USDCx');
    expect([0, 1, 2].map(index => screen.getByTestId(`deposit-processing-step-${index}`).dataset.state)).toEqual(
      states
    );
    expect(screen.queryByTestId('deposit-address-block')).not.toBeInTheDocument();
  });

  it('closes the processing screen to Home', () => {
    showRow({ phase: 'processing' });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('shows the success screen with the delivered amount, and its two actions', () => {
    showRow({ phase: 'delivered', amount: '45950000' });
    renderPage();
    expect(screen.getByTestId('deposit-success')).toBeInTheDocument();
    expect(screen.getByTestId('deposit-success-received')).toHaveTextContent('45.95 USDCx');
    expect(screen.getByTestId('deposit-success-facts')).toHaveTextContent('Ethereum');
    expect(screen.getByTestId('deposit-success-fee')).toHaveTextContent('$0.08');
    fireEvent.click(screen.getByTestId('deposit-success-done'));
    expect(mockNavigate).toHaveBeenLastCalledWith('/');
    fireEvent.click(screen.getByTestId('deposit-success-again'));
    expect(mockNavigate).toHaveBeenLastCalledWith('/bridge/deposit');
  });

  it('shows a refund as a failure that names the refund address', () => {
    showRow({ phase: 'refunded' });
    renderPage();
    expect(screen.getByTestId('hero-failed')).toBeInTheDocument();
    expect(screen.getByTestId('deposit-processing-failed')).toHaveTextContent('depositFlowNearRefunded');
    expect(screen.getByTestId('deposit-processing-failed')).toHaveTextContent('"address":"0x91b2');
  });

  it('shows a failed swap with the row reason, else the generic message', () => {
    showRow({ phase: 'failed', error: 'Slippage too high' });
    const view = renderPage();
    expect(screen.getByTestId('deposit-processing-failed')).toHaveTextContent('Slippage too high');
    view.unmount();

    showRow({ phase: 'failed' });
    renderPage();
    expect(screen.getByTestId('deposit-processing-failed')).toHaveTextContent('transactionErrorDescription');
  });

  it('shows an unknown fee when 1Click gave no USD values', () => {
    showRow({
      phase: 'delivered',
      quote: { ...nearTrackingFixture().quote, quote: { ...nearTrackingFixture().quote.quote, amountInUsd: '' } }
    });
    renderPage();
    expect(screen.getByTestId('deposit-success-fee')).toHaveTextContent('unknown');
  });
});

describe('NearIntentsDepositPage routing', () => {
  it('goes back to Receive for an unknown row', () => {
    mockRowState = { loaded: true, row: undefined };
    renderPage();
    expect(screen.getByTestId('redirect')).toHaveTextContent('/receive');
  });

  it('goes back to Receive for a row with no NEAR Intents tracking', () => {
    mockRowState = { loaded: true, row: nearRowFixture(undefined) };
    renderPage();
    expect(screen.getByTestId('redirect')).toHaveTextContent('/receive');
  });

  it('waits for the first read before it decides', () => {
    mockRowState = { loaded: false };
    renderPage();
    expect(screen.queryByTestId('redirect')).not.toBeInTheDocument();
    expect(screen.queryByTestId('near-intents-deposit-page')).not.toBeInTheDocument();
  });
});
