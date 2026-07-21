import React from 'react';

import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';

// Import after the mocks are registered.
import { SwapFlow } from './SwapManager';

// ---------------------------------------------------------------------------
// Fixture tokens. Prefixed `mock` so the hoisted jest.mock factories may close
// over them. Default flow: offer = AAA (index 0), request = BBB (index 1).
// ---------------------------------------------------------------------------
const mockTokenA = { symbol: 'AAA', faucetId: 'faucet-A', decimals: 8, logoSymbol: 'MIDEN' };
const mockTokenB = { symbol: 'BBB', faucetId: 'faucet-B', decimals: 8, logoSymbol: 'ETH' };
const mockTokenC = { symbol: 'CCC', faucetId: 'faucet-C', decimals: 8, logoSymbol: 'BTC' };

// Mutable module-level state driven per test (all `mock`-prefixed for hoisting).
let mockRenderedRoutes: Array<{ name: string }>;
let mockNav: { navigateTo: jest.Mock; goBack: jest.Mock; cardStack: Array<{ name: string }> };
let mockBackHandler: (() => boolean) | null;
let mockWalletState: {
  isTransactionModalOpen: boolean;
  lastCompletedTxHash: string | null;
  closeTransactionModal: jest.Mock;
  setLastCompletedTxHash: jest.Mock;
};
let mockSwapEtaState: {
  loading: boolean;
  eta?: {
    canFill: boolean;
    estimatedSeconds: number | null;
    offMarket: boolean;
    marketPrice: string;
    median24hSeconds: number | null;
  };
  error?: string;
};
let mockBalanceData: Array<{ tokenId: string; balance: number }>;
let mockAllBalancesReturn: { data?: Array<{ tokenId: string; balance: number }> };
let mockMetadata: Record<string, unknown>;
let mockAccountReturn: { publicKey: string };

// Latest props captured from the mocked children so tests can invoke callbacks
// with precise arguments (e.g. the drawer's `onSelect(token)`).
let mockDrawerProps: {
  open: boolean;
  currentFaucetId?: string;
  onOpenChange: (open: boolean) => void;
  onSelect: (token: typeof mockTokenA) => void;
};

const mockGetSwapTokens = jest.fn(() => [mockTokenA, mockTokenB, mockTokenC]);
const mockDeriveRequestAmount = jest.fn();
const mockUseSwapEta = jest.fn(() => mockSwapEtaState);
const mockUseAccount = jest.fn(() => mockAccountReturn);
const mockUseAllBalances = jest.fn((_pk: string, _md: Record<string, unknown>) => mockAllBalancesReturn);
const mockUseAllTokensBaseMetadata = jest.fn(() => mockMetadata);
const mockAccountIdStringToSdk = jest.fn((s: string) => s);
const mockGetBech32 = jest.fn((s: string) => `bech32-${s}`);
const mockConfirmSensitive = jest.fn().mockResolvedValue(true);
const mockStringToBigInt = jest.fn((str: string, _decimals: number) => BigInt(Math.trunc(Number(str) || 0)));
const mockInitiateSwap = jest.fn().mockResolvedValue('tx-1');
const mockRequestSWProcessing = jest.fn();
const mockIsExtension = jest.fn(() => true);
const mockIsDelegateProof = jest.fn(() => false);
const mockNavigate = jest.fn();

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// `react-i18next` — echo the key back so we can assert against raw keys.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// `components/Navigator` — replace the animated stack with a controllable stub:
// render `renderRoute` for each route in `mockRenderedRoutes` (so both flow
// steps mount at once for a single SwapManager instance), and hand back a
// controllable navigator context.
jest.mock('components/Navigator', () => ({
  useNavigator: () => mockNav,
  NavigatorProvider: ({ children }: { children: React.ReactNode }) => children,
  Navigator: ({ renderRoute }: { renderRoute: (route: { name: string }, index: number) => React.ReactNode }) =>
    mockRenderedRoutes.map((route, index) => (
      <div key={route.name} data-nav-route={route.name}>
        {renderRoute(route, index)}
      </div>
    ))
}));

// The three swap-flow children are exercised by their own suites; stub them to
// thin harnesses that surface every prop and forward every callback.
jest.mock('./SwapAmounts', () => ({
  SwapAmounts: (props: Record<string, any>) => (
    <div data-testid="swap-amounts">
      <span data-testid="sa-offer-token">{props.offerToken.symbol}</span>
      <span data-testid="sa-request-token">{props.requestToken.symbol}</span>
      <span data-testid="sa-offer-balance">{String(props.offerBalance)}</span>
      <span data-testid="sa-offer-amount">{props.offerAmount}</span>
      <span data-testid="sa-request-amount">{props.requestAmount}</span>
      <span data-testid="sa-can-proceed">{String(props.canProceed)}</span>
      <span data-testid="sa-status">{props.statusMessage ?? ''}</span>
      <span data-testid="sa-status-error">{String(props.statusIsError)}</span>
      <input data-testid="sa-offer-input" onChange={e => props.onOfferAmountChange(e.target.value)} />
      <input data-testid="sa-request-input" onChange={e => props.onRequestAmountChange(e.target.value)} />
      <button data-testid="sa-select-offer" onClick={props.onSelectOfferToken} />
      <button data-testid="sa-select-request" onClick={props.onSelectRequestToken} />
      <button data-testid="sa-swap-direction" onClick={props.onSwapDirection} />
      <button data-testid="sa-confirm" onClick={props.onConfirm} />
    </div>
  )
}));

jest.mock('./ReviewSwap', () => ({
  ReviewSwap: (props: Record<string, any>) => (
    <div data-testid="review-swap">
      <span data-testid="rs-offer-token">{props.offerToken.symbol}</span>
      <span data-testid="rs-request-token">{props.requestToken.symbol}</span>
      <span data-testid="rs-offer-amount">{props.offerAmount}</span>
      <span data-testid="rs-request-amount">{props.requestAmount}</span>
      <span data-testid="rs-market-price">{String(props.swapEta?.marketPrice)}</span>
      <span data-testid="rs-submit-error">{props.submitError ?? ''}</span>
      <button data-testid="rs-go-back" onClick={props.onGoBack} />
      <button data-testid="rs-submit" onClick={props.onSubmit} />
    </div>
  )
}));

jest.mock('./SelectSwapToken', () => ({
  SelectSwapTokenDrawer: (props: Record<string, any>) => {
    mockDrawerProps = props as typeof mockDrawerProps;
    return (
      <div data-testid="swap-token-drawer" data-open={String(props.open)} data-current={props.currentFaucetId ?? ''}>
        <button data-testid="drawer-close" onClick={() => props.onOpenChange(false)} />
      </div>
    );
  }
}));

jest.mock('lib/miden/swap/tokens', () => ({
  getSwapTokens: () => mockGetSwapTokens(),
  deriveRequestAmount: (...args: unknown[]) => mockDeriveRequestAmount(...args)
}));

jest.mock('./useSwapEta', () => ({
  useSwapEta: () => mockUseSwapEta()
}));

jest.mock('lib/miden/front', () => ({
  useAccount: () => mockUseAccount(),
  useAllBalances: (pk: string, md: Record<string, unknown>) => mockUseAllBalances(pk, md),
  useAllTokensBaseMetadata: () => mockUseAllTokensBaseMetadata()
}));

jest.mock('lib/miden/sdk/helpers', () => ({
  accountIdStringToSdk: (s: string) => mockAccountIdStringToSdk(s),
  getBech32AddressFromAccountId: (a: string) => mockGetBech32(a)
}));

jest.mock('lib/biometric', () => ({
  confirmSensitiveAction: (reason: string) => mockConfirmSensitive(reason)
}));

jest.mock('lib/i18n/numbers', () => ({
  stringToBigInt: (str: string, decimals: number) => mockStringToBigInt(str, decimals)
}));

jest.mock('lib/miden/activity', () => ({
  initiateSwapTransaction: (...args: unknown[]) => mockInitiateSwap(...args),
  requestSWTransactionProcessing: () => mockRequestSWProcessing()
}));

jest.mock('lib/platform', () => ({
  isExtension: () => mockIsExtension()
}));

jest.mock('lib/settings/helpers', () => ({
  isDelegateProofEnabled: () => mockIsDelegateProof()
}));

jest.mock('lib/mobile/useMobileBackHandler', () => ({
  useMobileBackHandler: (handler: () => boolean) => {
    mockBackHandler = handler;
  }
}));

jest.mock('lib/store', () => ({
  useWalletStore: Object.assign(
    (selector?: (state: typeof mockWalletState) => unknown) => (selector ? selector(mockWalletState) : mockWalletState),
    { getState: () => mockWalletState }
  )
}));

jest.mock('lib/woozie', () => ({
  navigate: (...args: unknown[]) => mockNavigate(...args),
  HistoryAction: { Push: 'push', Replace: 'replace' }
}));

const renderFlow = () => render(<SwapFlow />);

beforeEach(() => {
  jest.clearAllMocks();

  mockRenderedRoutes = [{ name: 'SwapAmounts' }, { name: 'ReviewSwap' }];
  mockNav = { navigateTo: jest.fn(), goBack: jest.fn(), cardStack: [{ name: 'SwapAmounts' }] };
  mockBackHandler = null;
  mockWalletState = {
    isTransactionModalOpen: false,
    lastCompletedTxHash: null,
    closeTransactionModal: jest.fn(),
    setLastCompletedTxHash: jest.fn()
  };
  mockSwapEtaState = {
    loading: false,
    eta: {
      canFill: true,
      estimatedSeconds: 30,
      offMarket: false,
      marketPrice: '2',
      median24hSeconds: 60
    }
  };
  mockBalanceData = [{ tokenId: 'bech32-faucet-A', balance: 100 }];
  mockAllBalancesReturn = { data: mockBalanceData };
  mockMetadata = { some: 'metadata' };
  mockAccountReturn = { publicKey: 'pk-1' };

  mockGetSwapTokens.mockImplementation(() => [mockTokenA, mockTokenB, mockTokenC]);
  mockGetBech32.mockImplementation((s: string) => `bech32-${s}`);
  mockAccountIdStringToSdk.mockImplementation((s: string) => s);
  mockConfirmSensitive.mockResolvedValue(true);
  mockInitiateSwap.mockResolvedValue('tx-1');
  mockIsExtension.mockReturnValue(true);
  mockIsDelegateProof.mockReturnValue(false);
  mockDeriveRequestAmount.mockImplementation((offerAmount: string) => (Number(offerAmount) > 0 ? '5' : ''));
});

afterEach(() => {
  cleanup();
});

const setOffer = (value: string) => fireEvent.change(screen.getByTestId('sa-offer-input'), { target: { value } });
const setRequest = (value: string) => fireEvent.change(screen.getByTestId('sa-request-input'), { target: { value } });

describe('SwapFlow / SwapManager', () => {
  it('renders both flow steps with the default token pair and the auto-derived quote', () => {
    renderFlow();

    expect(screen.getByTestId('swap-flow')).toBeInTheDocument();
    expect(screen.getByTestId('swap-amounts')).toBeInTheDocument();
    expect(screen.getByTestId('review-swap')).toBeInTheDocument();

    expect(screen.getByTestId('sa-offer-token')).toHaveTextContent('AAA');
    expect(screen.getByTestId('sa-request-token')).toHaveTextContent('BBB');
    // No pay amount yet → quote is empty and the CTA is disabled.
    expect(screen.getByTestId('sa-request-amount')).toHaveTextContent('');
    expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('false');
    expect(screen.getByTestId('sa-status')).toHaveTextContent('');

    // Review side receives the single live swap-eta quote.
    expect(screen.getByTestId('rs-market-price')).toHaveTextContent('2');

    // Drawer starts closed, keyed to the offer side by default.
    const drawer = screen.getByTestId('swap-token-drawer');
    expect(drawer).toHaveAttribute('data-open', 'false');
    expect(drawer).toHaveAttribute('data-current', 'faucet-A');
  });

  it('renders nothing for an unknown route (renderStep default branch)', () => {
    mockRenderedRoutes = [{ name: '__unknown__' }];
    renderFlow();

    expect(screen.queryByTestId('swap-amounts')).not.toBeInTheDocument();
    expect(screen.queryByTestId('review-swap')).not.toBeInTheDocument();
    // The flow shell + drawer still render.
    expect(screen.getByTestId('swap-flow')).toBeInTheDocument();
    expect(screen.getByTestId('swap-token-drawer')).toBeInTheDocument();
  });

  it('passes the account public key and base metadata through to useAllBalances', () => {
    renderFlow();
    expect(mockUseAllBalances).toHaveBeenCalledWith('pk-1', mockMetadata);
  });

  it('defaults balance data to an empty list when useAllBalances yields no data', () => {
    mockAllBalancesReturn = {};
    renderFlow();
    expect(screen.getByTestId('sa-offer-balance')).toHaveTextContent('0');
  });

  describe('offer balance resolution', () => {
    it('matches the balance by the bech32-normalized faucet key', () => {
      mockBalanceData = [{ tokenId: 'bech32-faucet-A', balance: 100 }];
      mockAllBalancesReturn = { data: mockBalanceData };
      renderFlow();
      expect(screen.getByTestId('sa-offer-balance')).toHaveTextContent('100');
    });

    it('falls back to matching the raw faucet id when the bech32 key differs', () => {
      mockGetBech32.mockImplementation(() => 'unrelated-key');
      mockBalanceData = [{ tokenId: 'faucet-A', balance: 50 }];
      mockAllBalancesReturn = { data: mockBalanceData };
      renderFlow();
      expect(screen.getByTestId('sa-offer-balance')).toHaveTextContent('50');
    });

    it('uses the raw faucet id as the key when bech32 conversion throws (catch branch)', () => {
      mockGetBech32.mockImplementation(() => {
        throw new Error('sdk not ready');
      });
      mockBalanceData = [{ tokenId: 'faucet-A', balance: 7 }];
      mockAllBalancesReturn = { data: mockBalanceData };
      renderFlow();
      expect(screen.getByTestId('sa-offer-balance')).toHaveTextContent('7');
    });

    it('resolves to 0 when no balance entry matches', () => {
      mockBalanceData = [{ tokenId: 'someone-else', balance: 999 }];
      mockAllBalancesReturn = { data: mockBalanceData };
      renderFlow();
      expect(screen.getByTestId('sa-offer-balance')).toHaveTextContent('0');
    });
  });

  describe('mount effect: dismissing a stale completion modal', () => {
    it('closes an open transaction modal and clears the last completed hash', () => {
      mockWalletState.isTransactionModalOpen = true;
      mockWalletState.lastCompletedTxHash = '0xabc';
      renderFlow();

      expect(mockWalletState.closeTransactionModal).toHaveBeenCalledWith(true);
      expect(mockWalletState.setLastCompletedTxHash).toHaveBeenCalledWith(null);
    });

    it('does nothing when no modal is open and no hash is set', () => {
      renderFlow();
      expect(mockWalletState.closeTransactionModal).not.toHaveBeenCalled();
      expect(mockWalletState.setLastCompletedTxHash).not.toHaveBeenCalled();
    });
  });

  describe('amount editing + quote mirroring', () => {
    it('mirrors the derived quote into the receive field and enables the CTA', () => {
      renderFlow();
      setOffer('10');

      expect(screen.getByTestId('sa-offer-amount')).toHaveTextContent('10');
      expect(screen.getByTestId('sa-request-amount')).toHaveTextContent('5');
      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('true');
    });

    it('pauses the auto-quote once the receive field is edited manually', () => {
      renderFlow();
      setRequest('9');

      expect(screen.getByTestId('sa-request-amount')).toHaveTextContent('9');
      // requestEdited is now true, so the quote no longer drives the field.
      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('false');
    });

    it('disables the CTA when the pay amount exceeds the balance', () => {
      mockBalanceData = [{ tokenId: 'bech32-faucet-A', balance: 5 }];
      mockAllBalancesReturn = { data: mockBalanceData };
      renderFlow();
      setOffer('10');

      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('false');
    });
  });

  it('swaps the two sides, seeding the pay field from the previous receive amount', () => {
    renderFlow();
    setOffer('10');
    expect(screen.getByTestId('sa-request-amount')).toHaveTextContent('5');

    fireEvent.click(screen.getByTestId('sa-swap-direction'));

    expect(screen.getByTestId('sa-offer-token')).toHaveTextContent('BBB');
    expect(screen.getByTestId('sa-request-token')).toHaveTextContent('AAA');
    // Pay field seeded with the old receive amount (5); receive re-derived to 5.
    expect(screen.getByTestId('sa-offer-amount')).toHaveTextContent('5');
  });

  describe('token drawer', () => {
    it('opens keyed to the offer side and forwards close events', () => {
      renderFlow();
      fireEvent.click(screen.getByTestId('sa-select-offer'));

      const drawer = screen.getByTestId('swap-token-drawer');
      expect(drawer).toHaveAttribute('data-open', 'true');
      expect(drawer).toHaveAttribute('data-current', 'faucet-A');

      fireEvent.click(screen.getByTestId('drawer-close'));
      expect(screen.getByTestId('swap-token-drawer')).toHaveAttribute('data-open', 'false');
    });

    it('opens keyed to the request side', () => {
      renderFlow();
      fireEvent.click(screen.getByTestId('sa-select-request'));

      const drawer = screen.getByTestId('swap-token-drawer');
      expect(drawer).toHaveAttribute('data-open', 'true');
      expect(drawer).toHaveAttribute('data-current', 'faucet-B');
    });

    it('offer side: picking the token already on the request side flips the pair', () => {
      renderFlow();
      fireEvent.click(screen.getByTestId('sa-select-offer'));
      act(() => mockDrawerProps.onSelect(mockTokenB));

      expect(screen.getByTestId('sa-offer-token')).toHaveTextContent('BBB');
      expect(screen.getByTestId('sa-request-token')).toHaveTextContent('AAA');
    });

    it('offer side: picking a fresh token just replaces the offer token', () => {
      renderFlow();
      fireEvent.click(screen.getByTestId('sa-select-offer'));
      act(() => mockDrawerProps.onSelect(mockTokenC));

      expect(screen.getByTestId('sa-offer-token')).toHaveTextContent('CCC');
      expect(screen.getByTestId('sa-request-token')).toHaveTextContent('BBB');
    });

    it('request side: picking the token already on the offer side flips the pair', () => {
      renderFlow();
      fireEvent.click(screen.getByTestId('sa-select-request'));
      act(() => mockDrawerProps.onSelect(mockTokenA));

      expect(screen.getByTestId('sa-offer-token')).toHaveTextContent('BBB');
      expect(screen.getByTestId('sa-request-token')).toHaveTextContent('AAA');
    });

    it('request side: picking a fresh token just replaces the request token', () => {
      renderFlow();
      fireEvent.click(screen.getByTestId('sa-select-request'));
      act(() => mockDrawerProps.onSelect(mockTokenC));

      expect(screen.getByTestId('sa-offer-token')).toHaveTextContent('AAA');
      expect(screen.getByTestId('sa-request-token')).toHaveTextContent('CCC');
    });
  });

  describe('status message', () => {
    it('shows a same-token error when both sides are the same faucet', () => {
      mockGetSwapTokens.mockImplementation(() => [mockTokenA, mockTokenA, mockTokenC]);
      renderFlow();

      expect(screen.getByTestId('sa-status')).toHaveTextContent('swapSameToken');
      expect(screen.getByTestId('sa-status-error')).toHaveTextContent('true');
      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('false');
    });

    it('shows a price-unavailable error when the swap-eta request errors', () => {
      mockSwapEtaState = { loading: false, error: 'quote boom' };
      renderFlow();
      setOffer('10');

      expect(screen.getByTestId('sa-status')).toHaveTextContent('swapPriceUnavailable');
      expect(screen.getByTestId('sa-status-error')).toHaveTextContent('true');
    });

    it('uses the receive-field loading state instead of a separate status message while quoting', () => {
      mockSwapEtaState = { loading: true };
      renderFlow();
      setOffer('10');

      expect(screen.getByTestId('sa-status')).toHaveTextContent('');
      expect(screen.getByTestId('sa-status-error')).toHaveTextContent('undefined');
    });
  });

  it('navigates to the review step from the amounts CTA', () => {
    renderFlow();
    fireEvent.click(screen.getByTestId('sa-confirm'));
    expect(mockNav.navigateTo).toHaveBeenCalledWith('ReviewSwap');
  });

  it('goes back from the review step', () => {
    renderFlow();
    fireEvent.click(screen.getByTestId('rs-go-back'));
    expect(mockNav.goBack).toHaveBeenCalled();
  });

  describe('onSubmit', () => {
    it('rejects an empty pay amount with a validation error', async () => {
      renderFlow();
      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('swapInvalidAmounts');
      expect(mockInitiateSwap).not.toHaveBeenCalled();
    });

    it('rejects a same-token swap with a validation error', async () => {
      mockGetSwapTokens.mockImplementation(() => [mockTokenA, mockTokenA, mockTokenC]);
      renderFlow();
      setOffer('10');
      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('swapInvalidAmounts');
      expect(mockInitiateSwap).not.toHaveBeenCalled();
    });

    it('rejects when the derived receive amount is zero', async () => {
      mockDeriveRequestAmount.mockImplementation(() => '');
      renderFlow();
      setOffer('10');
      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('swapInvalidAmounts');
      expect(mockInitiateSwap).not.toHaveBeenCalled();
    });

    it('rejects when the pay amount exceeds the balance', async () => {
      mockBalanceData = [{ tokenId: 'bech32-faucet-A', balance: 5 }];
      mockAllBalancesReturn = { data: mockBalanceData };
      renderFlow();
      setOffer('10');
      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('swapInvalidAmounts');
      expect(mockInitiateSwap).not.toHaveBeenCalled();
    });

    it('is a no-op when there is no public key', async () => {
      mockAccountReturn = { publicKey: '' };
      renderFlow();
      setOffer('10');
      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(mockInitiateSwap).not.toHaveBeenCalled();
      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('');
    });

    it('ignores a second submit while the first is still in flight', async () => {
      let releaseConfirm: (v: boolean) => void = () => {};
      mockConfirmSensitive.mockReturnValueOnce(
        new Promise<boolean>(resolve => {
          releaseConfirm = resolve;
        })
      );
      renderFlow();
      setOffer('10');

      // First click enters the in-flight state (confirm pending).
      fireEvent.click(screen.getByTestId('rs-submit'));
      // Second click short-circuits on the `submitting` guard.
      fireEvent.click(screen.getByTestId('rs-submit'));

      expect(mockConfirmSensitive).toHaveBeenCalledTimes(1);

      await act(async () => {
        releaseConfirm(false);
      });
    });

    it('does not submit when biometric confirmation is declined', async () => {
      mockConfirmSensitive.mockResolvedValue(false);
      renderFlow();
      setOffer('10');
      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(mockConfirmSensitive).toHaveBeenCalledWith('Confirm your swap');
      expect(mockInitiateSwap).not.toHaveBeenCalled();
      expect(mockWalletState.setLastCompletedTxHash).not.toHaveBeenCalled();
    });

    it('submits, nudges the service worker on extension, and hands off to the progress page', async () => {
      mockIsDelegateProof.mockReturnValue(true);
      mockInitiateSwap.mockResolvedValue('tx 123');
      renderFlow();
      setOffer('10');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(mockWalletState.setLastCompletedTxHash).toHaveBeenCalledWith(null);
      expect(mockInitiateSwap).toHaveBeenCalledWith('pk-1', 'faucet-A', 10n, 'faucet-B', 5n, true);
      expect(mockRequestSWProcessing).toHaveBeenCalled();
      expect(mockNavigate).toHaveBeenCalledWith('/generating-transaction/tx%20123', 'replace');
      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('');
    });

    it('does not nudge the service worker off-extension', async () => {
      mockIsExtension.mockReturnValue(false);
      renderFlow();
      setOffer('10');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(mockInitiateSwap).toHaveBeenCalled();
      expect(mockRequestSWProcessing).not.toHaveBeenCalled();
      expect(mockNavigate).toHaveBeenCalledWith('/generating-transaction/tx-1', 'replace');
    });

    it('surfaces an Error message when the swap fails', async () => {
      mockInitiateSwap.mockRejectedValue(new Error('chain rejected'));
      renderFlow();
      setOffer('10');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('chain rejected');
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('stringifies a non-Error rejection', async () => {
      mockInitiateSwap.mockRejectedValue('plain failure');
      renderFlow();
      setOffer('10');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('plain failure');
    });
  });

  describe('mobile back handler', () => {
    it('closes the token drawer first when it is open', () => {
      renderFlow();
      fireEvent.click(screen.getByTestId('sa-select-offer'));
      expect(screen.getByTestId('swap-token-drawer')).toHaveAttribute('data-open', 'true');

      let handled: boolean | undefined;
      act(() => {
        handled = mockBackHandler!();
      });

      expect(handled).toBe(true);
      expect(screen.getByTestId('swap-token-drawer')).toHaveAttribute('data-open', 'false');
    });

    it('steps back inside the flow when the card stack has depth', () => {
      mockNav.cardStack = [{ name: 'SwapAmounts' }, { name: 'ReviewSwap' }];
      renderFlow();

      let handled: boolean | undefined;
      act(() => {
        handled = mockBackHandler!();
      });

      expect(handled).toBe(true);
      expect(mockNav.goBack).toHaveBeenCalled();
    });

    it('closes the flow when the drawer is shut and the stack is at the root', () => {
      renderFlow();

      let handled: boolean | undefined;
      act(() => {
        handled = mockBackHandler!();
      });

      expect(handled).toBe(true);
      expect(mockNavigate).toHaveBeenCalledWith('/');
    });
  });
});
