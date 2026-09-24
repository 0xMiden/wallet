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
  assessSpendingLimit: jest.Mock;
};
let mockSwapEtaResult: { loading: boolean; eta?: Record<string, unknown>; error?: string };
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
const mockUseSwapEta = jest.fn();
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
let mockBaseFee = 0;
jest.mock('app/hooks/useVerificationBaseFee', () => ({ __esModule: true, default: () => mockBaseFee }));
let mockNativeFaucetId: string | null = 'MIDEN-ID';
jest.mock('app/hooks/useMidenFaucetId', () => ({ __esModule: true, default: () => mockNativeFaucetId }));
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
      <span data-testid="sa-request-loading">{String(props.requestLoading)}</span>
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
    <div data-testid="review-swap" data-submitting={String(Boolean(props.submitting))}>
      <span data-testid="rs-offer-token">{props.offerToken.symbol}</span>
      <span data-testid="rs-request-token">{props.requestToken.symbol}</span>
      <span data-testid="rs-offer-amount">{props.offerAmount}</span>
      <span data-testid="rs-request-amount">{props.requestAmount}</span>
      <span data-testid="rs-market-price">{String(props.swapEta?.marketPrice)}</span>
      <input
        data-testid="rs-expiry"
        value={props.expirySeconds}
        onChange={event => props.onExpirySecondsChange(event.target.value)}
      />
      <button data-testid="rs-auto-consume" onClick={() => props.onAutoConsumeChange(!props.autoConsume)}>
        {String(props.autoConsume)}
      </button>
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

jest.mock('components/SpendingLimitChallenge', () => ({
  SpendingLimitChallenge: (props: any) => {
    return (
      <div data-testid="spending-limit-challenge">
        <span>{props.assessment.revision}</span>
        <button
          type="button"
          onClick={() =>
            props.onResult({
              id: 'authorization-1',
              accountId: props.assessment.accountId,
              faucetId: props.assessment.faucetId,
              amount: props.assessment.amount,
              revision: props.assessment.revision,
              issuedAt: 120,
              expiresAt: 240
            })
          }
        >
          authorize-limit
        </button>
        <button type="button" onClick={() => props.onResult(undefined)}>
          cancel-limit
        </button>
      </div>
    );
  }
}));

jest.mock('lib/miden/swap/tokens', () => ({
  getSwapTokens: () => mockGetSwapTokens(),
  // The form seeds its pair by SYMBOL, not list position, so a cold and a warm
  // start open on the same pair; mirror that here over the mocked registry.
  getDefaultSwapPair: () => {
    const tokens = mockGetSwapTokens();
    const bySymbol = (symbol: string) => tokens.find((token: { symbol: string }) => token.symbol === symbol);
    const offer = bySymbol('IMIDEN') ?? tokens[0];
    const request = bySymbol('IETH') ?? tokens[1];
    return { offer, request };
  },
  deriveRequestAmount: (...args: unknown[]) => mockDeriveRequestAmount(...args)
}));

jest.mock('./useSwapEta', () => ({
  useSwapEta: (...args: unknown[]) => mockUseSwapEta(...args)
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

  mockBaseFee = 0;
  mockNativeFaucetId = 'MIDEN-ID';
  mockRenderedRoutes = [{ name: 'SwapAmounts' }, { name: 'ReviewSwap' }];
  mockNav = { navigateTo: jest.fn(), goBack: jest.fn(), cardStack: [{ name: 'SwapAmounts' }] };
  mockBackHandler = null;
  mockWalletState = {
    isTransactionModalOpen: false,
    lastCompletedTxHash: null,
    closeTransactionModal: jest.fn(),
    setLastCompletedTxHash: jest.fn(),
    assessSpendingLimit: jest.fn().mockResolvedValue(undefined)
  };
  mockSwapEtaResult = {
    loading: false,
    eta: { canFill: false, estimatedSeconds: null, offMarket: false, marketPrice: '2', median24hSeconds: null }
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

  mockUseSwapEta.mockImplementation(() => mockSwapEtaResult);
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

    // Review side reflects the live oracle rate from the swap-eta quote.
    expect(screen.getByTestId('rs-market-price')).toHaveTextContent('2');
    expect(screen.getByTestId('rs-expiry')).toHaveValue('120');
    expect(screen.getByTestId('rs-auto-consume')).toHaveTextContent('true');

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

  describe('fee reserve on a NATIVE offer', () => {
    // The fee comes out of this account's own vault, so offering the entire native
    // balance is accepted and then fails in the epilogue on its own fee -- AFTER the
    // user signed. Send already reserves for this; swap quoted and enforced the raw
    // balance, so the same signed-then-failed outcome was still reachable here.
    // Reserve = baseFee * FEE_RESERVE_MULTIPLE / 10^decimals = 10000*30/1e8 = 0.003.
    it('holds back the fee reserve from the offerable balance', () => {
      mockNativeFaucetId = 'bech32-faucet-A';
      mockBaseFee = 10000;
      mockBalanceData = [{ tokenId: 'bech32-faucet-A', balance: 100 }];
      mockAllBalancesReturn = { data: mockBalanceData };
      renderFlow();
      // Quoted "Available" must equal what the validation enforces, or Max overshoots.
      expect(screen.getByTestId('sa-offer-balance')).toHaveTextContent('99.997');
    });

    it('leaves a NON-NATIVE offer at its full balance', () => {
      // Its fee is paid in a different asset, so nothing needs holding back.
      mockNativeFaucetId = 'MIDEN-ID';
      mockBaseFee = 10000;
      mockBalanceData = [{ tokenId: 'bech32-faucet-A', balance: 100 }];
      mockAllBalancesReturn = { data: mockBalanceData };
      renderFlow();
      expect(screen.getByTestId('sa-offer-balance')).toHaveTextContent('100');
    });

    it('leaves the full balance on a zero-fee chain', () => {
      // `maxSendableNative` fails open, so a chain that charges nothing -- and the
      // window before discovery lands -- keeps the whole balance offerable.
      mockNativeFaucetId = 'bech32-faucet-A';
      mockBaseFee = 0;
      mockBalanceData = [{ tokenId: 'bech32-faucet-A', balance: 100 }];
      mockAllBalancesReturn = { data: mockBalanceData };
      renderFlow();
      expect(screen.getByTestId('sa-offer-balance')).toHaveTextContent('100');
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

    it('shows a price-unavailable error when the quote errors', () => {
      mockSwapEtaResult = { loading: false, error: 'quote boom' };
      renderFlow();
      setOffer('10');

      expect(screen.getByTestId('sa-status')).toHaveTextContent('swapPriceUnavailable');
      expect(screen.getByTestId('sa-status-error')).toHaveTextContent('true');
    });

    it('shows no status message once a quote has landed', () => {
      renderFlow();
      setOffer('10');

      expect(screen.getByTestId('sa-status')).toHaveTextContent('');
    });
  });

  describe('receive-field skeleton', () => {
    it('flags the receive field as calculating while the first quote is pending', () => {
      mockDeriveRequestAmount.mockImplementation(() => '');
      mockSwapEtaResult = { loading: true };
      renderFlow();
      setOffer('10');

      expect(screen.getByTestId('sa-request-loading')).toHaveTextContent('true');
    });

    it('clears the skeleton once the quote seeds the receive amount', () => {
      renderFlow();
      setOffer('10');

      expect(screen.getByTestId('sa-request-amount')).toHaveTextContent('5');
      expect(screen.getByTestId('sa-request-loading')).toHaveTextContent('false');
    });

    it('clears the skeleton when the quote errors instead of spinning forever', () => {
      mockDeriveRequestAmount.mockImplementation(() => '');
      mockSwapEtaResult = { loading: false, error: 'quote boom' };
      renderFlow();
      setOffer('10');

      expect(screen.getByTestId('sa-request-loading')).toHaveTextContent('false');
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
    it('submits the edited expiry and auto-consume preference', async () => {
      renderFlow();
      setOffer('10');
      fireEvent.change(screen.getByTestId('rs-expiry'), { target: { value: '300' } });
      fireEvent.click(screen.getByTestId('rs-auto-consume'));

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(mockInitiateSwap).toHaveBeenCalledWith('pk-1', 'faucet-A', 10n, 'faucet-B', 5n, false, 300, false);
      expect(mockWalletState.assessSpendingLimit).toHaveBeenCalledWith('pk-1', 'faucet-A', 10n);
    });

    it('tells the review screen a submission is in flight while the spending limit is assessed', async () => {
      let settle!: (value: undefined) => void;
      mockWalletState.assessSpendingLimit.mockReturnValue(new Promise(resolve => (settle = resolve)));
      renderFlow();
      setOffer('10');
      expect(screen.getByTestId('review-swap')).toHaveAttribute('data-submitting', 'false');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });
      expect(screen.getByTestId('review-swap')).toHaveAttribute('data-submitting', 'true');

      await act(async () => settle(undefined));
    });

    it('holds the review still while a press is in flight: the amount shown is the one sent', async () => {
      let settle!: (value: undefined) => void;
      mockWalletState.assessSpendingLimit.mockReturnValue(new Promise(resolve => (settle = resolve)));
      mockDeriveRequestAmount.mockImplementation((offerAmount: string, marketPrice: string) =>
        Number(offerAmount) > 0 ? (marketPrice === '3' ? '7' : '5') : ''
      );
      const { rerender } = renderFlow();
      setOffer('10');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });
      mockSwapEtaResult = { ...mockSwapEtaResult, eta: { ...mockSwapEtaResult.eta, marketPrice: '3' } };
      rerender(<SwapFlow />);
      expect(screen.getByTestId('rs-request-amount')).toHaveTextContent('5');

      await act(async () => settle(undefined));
      expect(mockInitiateSwap).toHaveBeenCalledWith('pk-1', 'faucet-A', 10n, 'faucet-B', 5n, false, 120, true);
    });

    it('catches the review up with the latest quote once a press settles on Review', async () => {
      let releaseConfirm!: (confirmed: boolean) => void;
      mockConfirmSensitive.mockReturnValueOnce(new Promise<boolean>(resolve => (releaseConfirm = resolve)));
      mockDeriveRequestAmount.mockImplementation((offerAmount: string, marketPrice: string) =>
        Number(offerAmount) > 0 ? (marketPrice === '3' ? '7' : '5') : ''
      );
      const { rerender } = renderFlow();
      setOffer('10');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });
      mockSwapEtaResult = { ...mockSwapEtaResult, eta: { ...mockSwapEtaResult.eta, marketPrice: '3' } };
      rerender(<SwapFlow />);

      await act(async () => releaseConfirm(false));
      expect(screen.getByTestId('review-swap')).toHaveAttribute('data-submitting', 'false');
      expect(screen.getByTestId('rs-request-amount')).toHaveTextContent('7');
      expect(mockInitiateSwap).not.toHaveBeenCalled();
    });

    it('discards a spending-limit assessment minted for another account', async () => {
      // The staleness guard exists because the account can change under an open challenge. An
      // assessment naming a different account can never authorize this swap, so it is dropped
      // before it reaches the user rather than being shown and then refused at the chokepoint.
      mockWalletState.assessSpendingLimit.mockResolvedValue({
        accountId: 'pk-someone-else',
        faucetId: 'faucet-A',
        amount: 10n,
        revision: 'revision-1',
        assessedAt: 100,
        breaches: [{ period: '24h', spent: 95n, proposedTotal: 105n, limit: 100n, overBy: 5n, resetAt: 200 }]
      });
      renderFlow();
      setOffer('10');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
      expect(mockInitiateSwap).not.toHaveBeenCalled();
    });

    it('uses strict authentication instead of ordinary confirmation for a spending-limit breach', async () => {
      mockWalletState.assessSpendingLimit.mockResolvedValue({
        accountId: 'pk-1',
        faucetId: 'faucet-A',
        amount: 10n,
        revision: 'revision-1',
        assessedAt: 100,
        breaches: [{ period: '24h', spent: 95n, proposedTotal: 105n, limit: 100n, overBy: 5n, resetAt: 200 }]
      });
      renderFlow();
      setOffer('10');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();
      expect(mockConfirmSensitive).not.toHaveBeenCalled();
      expect(mockInitiateSwap).not.toHaveBeenCalled();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' }));
      });

      expect(mockInitiateSwap).toHaveBeenCalledWith(
        'pk-1',
        'faucet-A',
        10n,
        'faucet-B',
        5n,
        false,
        120,
        true,
        expect.objectContaining({
          id: 'authorization-1',
          accountId: 'pk-1',
          faucetId: 'faucet-A',
          amount: 10n,
          revision: 'revision-1'
        })
      );
      expect(mockConfirmSensitive).not.toHaveBeenCalled();
    });

    it('cancels a spending-limit challenge without queueing or losing the swap draft', async () => {
      mockWalletState.assessSpendingLimit.mockResolvedValue({
        accountId: 'pk-1',
        faucetId: 'faucet-A',
        amount: 10n,
        revision: 'revision-1',
        assessedAt: 100,
        breaches: [{ period: '7d', spent: 95n, proposedTotal: 105n, limit: 100n, overBy: 5n, resetAt: null }]
      });
      renderFlow();
      setOffer('10');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });
      fireEvent.click(screen.getByRole('button', { name: 'cancel-limit' }));

      expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
      expect(mockInitiateSwap).not.toHaveBeenCalled();
      expect(screen.getByTestId('rs-offer-amount')).toHaveTextContent('10');
    });

    it('reopens the challenge with the final atomic assessment after an expiry or insertion race', async () => {
      const firstAssessment = {
        accountId: 'pk-1',
        faucetId: 'faucet-A',
        amount: 10n,
        revision: 'revision-1',
        assessedAt: 100,
        breaches: [{ period: '24h', spent: 95n, proposedTotal: 105n, limit: 100n, overBy: 5n, resetAt: 200 }]
      };
      mockWalletState.assessSpendingLimit.mockResolvedValue(firstAssessment);
      mockInitiateSwap.mockRejectedValue({
        code: 'SPENDING_LIMIT_AUTHORIZATION_REQUIRED',
        assessment: {
          ...firstAssessment,
          revision: 'revision-2',
          assessedAt: 121,
          breaches: [{ ...firstAssessment.breaches[0], spent: 99n, proposedTotal: 109n, overBy: 9n }]
        }
      });
      renderFlow();
      setOffer('10');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' }));
      });

      expect(screen.getByTestId('spending-limit-challenge')).toHaveTextContent('revision-2');
      expect(screen.getByTestId('rs-offer-amount')).toHaveTextContent('10');
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('rejects a non-positive expiry', async () => {
      renderFlow();
      setOffer('10');
      fireEvent.change(screen.getByTestId('rs-expiry'), { target: { value: '0' } });

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(mockInitiateSwap).not.toHaveBeenCalled();
      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('swapInvalidAmounts');
    });

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

      await act(async () => {
        await Promise.resolve();
      });
      expect(mockWalletState.assessSpendingLimit).toHaveBeenCalledTimes(1);
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
      expect(mockInitiateSwap).toHaveBeenCalledWith('pk-1', 'faucet-A', 10n, 'faucet-B', 5n, true, 120, true);
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

  describe('an open spending-limit challenge holds the review still', () => {
    const breach = {
      accountId: 'pk-1',
      faucetId: 'faucet-A',
      amount: 10n,
      revision: 'revision-1',
      assessedAt: 100,
      breaches: [{ period: '24h', spent: 95n, proposedTotal: 105n, limit: 100n, overBy: 5n, resetAt: 200 }]
    };

    const openChallengeThenMoveMarket = async () => {
      mockWalletState.assessSpendingLimit.mockResolvedValue(breach);
      mockDeriveRequestAmount.mockImplementation((offerAmount: string, marketPrice: string) =>
        Number(offerAmount) > 0 ? (marketPrice === '3' ? '7' : '5') : ''
      );
      const view = renderFlow();
      setOffer('10');
      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });
      expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();
      mockSwapEtaResult = { ...mockSwapEtaResult, eta: { ...mockSwapEtaResult.eta, marketPrice: '3' } };
      view.rerender(<SwapFlow />);
      return view;
    };

    it('sends the amount the press reviewed when the challenge is approved after the market moves', async () => {
      await openChallengeThenMoveMarket();
      expect(screen.getByTestId('rs-request-amount')).toHaveTextContent('5');

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' }));
      });

      expect(mockInitiateSwap).toHaveBeenCalledWith(
        'pk-1',
        'faucet-A',
        10n,
        'faucet-B',
        5n,
        false,
        120,
        true,
        expect.objectContaining({ revision: 'revision-1' })
      );
    });

    it('keeps the reviewed amount under a revised challenge and sends it on approval', async () => {
      mockWalletState.assessSpendingLimit.mockResolvedValue(breach);
      mockInitiateSwap.mockRejectedValueOnce({
        code: 'SPENDING_LIMIT_AUTHORIZATION_REQUIRED',
        assessment: { ...breach, revision: 'revision-2', assessedAt: 121 }
      });
      mockDeriveRequestAmount.mockImplementation((offerAmount: string, marketPrice: string) =>
        Number(offerAmount) > 0 ? (marketPrice === '3' ? '7' : '5') : ''
      );
      const { rerender } = renderFlow();
      setOffer('10');
      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' }));
      });
      expect(screen.getByTestId('spending-limit-challenge')).toHaveTextContent('revision-2');

      mockSwapEtaResult = { ...mockSwapEtaResult, eta: { ...mockSwapEtaResult.eta, marketPrice: '3' } };
      rerender(<SwapFlow />);
      expect(screen.getByTestId('rs-request-amount')).toHaveTextContent('5');

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' }));
      });
      expect(mockInitiateSwap).toHaveBeenLastCalledWith(
        'pk-1',
        'faucet-A',
        10n,
        'faucet-B',
        5n,
        false,
        120,
        true,
        expect.objectContaining({ revision: 'revision-2' })
      );
    });

    it('catches the review up to the new quote once the challenge is dismissed', async () => {
      await openChallengeThenMoveMarket();

      fireEvent.click(screen.getByRole('button', { name: 'cancel-limit' }));

      expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
      expect(screen.getByTestId('rs-request-amount')).toHaveTextContent('7');
    });

    it('catches the review up once mobile back abandons the challenge', async () => {
      await openChallengeThenMoveMarket();

      act(() => {
        mockBackHandler!();
      });

      expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
      expect(screen.getByTestId('rs-request-amount')).toHaveTextContent('7');
    });

    it('catches the review up once the stale-context reset abandons the challenge', async () => {
      const { rerender } = await openChallengeThenMoveMarket();

      mockAccountReturn = { publicKey: 'pk-2' };
      rerender(<SwapFlow />);

      expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
      expect(screen.getByTestId('rs-request-amount')).toHaveTextContent('7');
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

    it('goes nowhere while a submission is in flight at Review', async () => {
      mockWalletState.assessSpendingLimit.mockReturnValue(new Promise(() => undefined));
      mockNav.cardStack = [{ name: 'SwapAmounts' }, { name: 'ReviewSwap' }];
      renderFlow();
      setOffer('10');
      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      let handled: boolean | undefined;
      act(() => {
        handled = mockBackHandler!();
      });

      expect(handled).toBe(true);
      expect(mockNav.goBack).not.toHaveBeenCalled();
      expect(mockNavigate).not.toHaveBeenCalled();
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
