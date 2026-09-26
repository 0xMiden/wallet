import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import BigNumber from 'bignumber.js';

import { TOKEN_IETH } from 'lib/miden/swap/tokens';

// utils/miden.isHexAddress is a pure `startsWith('0x')` helper with no imports —
// used for real so the redirect branch reflects production behaviour.

import Explore from './Explore';

// ---------------------------------------------------------------------------
// Explore is the wallet "home" page. It composes a lot of leaf UI (Balance,
// BalanceCard, AccountsDrawer, SearchInput, AssetRow, HomePrompts) and wires up
// several effects (auto-consume of claimable notes, redirect-on-hex-address,
// and a commented-out faucet poll). None of the leaf components carry Explore's
// own logic, so every import is stubbed to a minimal, behaviour-preserving
// double and we exercise Explore's branches directly:
//   - midenNotes memo: auto-consume disabled / no notes / faucet filtering
//   - autoConsume: extension vs. background dispatch, skip already-claiming,
//     skip when nothing to claim
//   - hex-address redirect (returns null + navigates to /reset-required)
//   - filteredTokens memo: empty search sort, and symbol/name search matching
//   - HomeOverview interactions: open accounts drawer, search, asset-row click
//
// Mutable `mock*`-prefixed module vars let each test drive the stubbed hooks;
// the "mock" prefix is required for jest.mock factory hoisting.
// ---------------------------------------------------------------------------

let mockFaucetId: string | null = 'faucet-native';
let mockAccount: { publicKey: string } = { publicKey: 'mtst1account' };
let mockAllBalances: any;
let mockClaimableNotes: any;
let mockClaimableNotesAreCached = false;
let mockAutoConsume = false;
let mockDelegateProof = false;
let mockTokenPrices: Record<string, unknown> = {};
let mockBalancesLoading = false;
let mockBaseFee: number | null = 0;

const mockSignTransaction = jest.fn();
const mockMutateBalances = jest.fn();
const mockMutateClaimableNotes = jest.fn();
const mockInitiateConsumeTransaction = jest.fn();
const mockRequestSWTransactionProcessing = jest.fn();
const mockStartBackgroundTransactionProcessing = jest.fn();
const mockNavigate = jest.fn();
const mockClearNoteReceivedNotification = jest.fn();

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('app/hooks/useMidenFaucetId', () => ({
  __esModule: true,
  default: () => mockFaucetId
}));
jest.mock('app/hooks/useVerificationBaseFee', () => ({
  __esModule: true,
  default: () => mockBaseFee
}));

// Balance is a render-prop that hands its child the total fiat BigNumber; the child converts it
// to a number for `AnimatedNumber` and formats it through the (mocked) toLocalFormat.
let mockPortfolioTotal: BigNumber | null = new BigNumber(0);
jest.mock('app/templates/Balance', () => ({
  __esModule: true,
  default: ({ children }: { children: (b: BigNumber | null) => React.ReactElement }) => children(mockPortfolioTotal)
}));

jest.mock('app/templates/HomePrompts', () => ({
  __esModule: true,
  default: ({
    account,
    claimableNotes,
    fundingNotes,
    tokenPrices
  }: {
    account: { publicKey: string };
    claimableNotes?: unknown[];
    fundingNotes?: unknown[];
    tokenPrices: Record<string, unknown>;
  }) => (
    <div
      data-testid="home-prompts"
      data-note-count={claimableNotes?.length ?? 0}
      data-funding-notes={fundingNotes === undefined ? 'unloaded' : String(fundingNotes.length)}
      data-price-symbols={Object.keys(tokenPrices).join(',')}
    >
      {account?.publicKey}
    </div>
  )
}));

jest.mock('components/AssetRow', () => ({
  AssetRow: ({ asset, onClick }: { asset: any; onClick: () => void }) => (
    <button data-testid="asset-row" data-token={asset.tokenId} onClick={onClick}>
      {asset.metadata.symbol}
    </button>
  )
}));

jest.mock('components/ConnectivityIssueBanner', () => ({
  ConnectivityIssueBanner: () => <div data-testid="connectivity-banner" />
}));

jest.mock('components/Loader', () => ({
  Loader: (props: React.HTMLAttributes<HTMLDivElement>) => <div data-testid="refresh-loader" {...props} />
}));

jest.mock('components/ui', () => ({
  AnimatedNumber: ({ value, format }: { value: number | null; format: (value: number) => string }) =>
    typeof value === 'number' && Number.isFinite(value) ? <span>{format(value)}</span> : null,
  BalanceCard: ({
    accountNumber,
    accountId,
    amount,
    onMore,
    state,
    delta
  }: {
    accountNumber: string;
    accountId: string;
    amount: React.ReactNode;
    onMore: () => void;
    state?: string;
    // Surfaced so a test can see what Home passes: a stub that drops it makes the call site
    // unobservable, which is how a fabricated change pill shipped.
    delta?: unknown;
  }) => (
    <div data-testid="balance-card" data-state={state} data-delta={delta === undefined ? 'none' : 'passed'}>
      <span data-testid="balance-account-number">{accountNumber}</span>
      <span data-testid="balance-account-id">{accountId}</span>
      <span data-testid="balance-amount">{amount}</span>
      <button data-testid="balance-more" onClick={onMore}>
        more
      </button>
    </div>
  ),
  AccountsDrawer: ({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) =>
    open ? (
      <div data-testid="accounts-drawer">
        <button data-testid="drawer-close" onClick={() => onOpenChange(false)}>
          close
        </button>
      </div>
    ) : null,
  AssetListItemSkeleton: (props: { 'data-testid'?: string }) => <div data-testid={props['data-testid']} />,
  SearchInput: ({
    value,
    onChange,
    placeholder
  }: {
    value: string;
    onChange: (v: string) => void;
    placeholder: string;
  }) => (
    <input
      data-testid="search-input"
      placeholder={placeholder}
      value={value}
      onChange={e => onChange(e.target.value)}
    />
  )
}));

jest.mock('lib/i18n/numbers', () => ({
  toLocalFormat: (v: unknown) => String(v)
}));

jest.mock('lib/miden/activity', () => ({
  initiateConsumeTransaction: (...args: any[]) => mockInitiateConsumeTransaction(...args),
  requestSWTransactionProcessing: (...args: any[]) => mockRequestSWTransactionProcessing(...args),
  startBackgroundTransactionProcessing: (...args: any[]) => mockStartBackgroundTransactionProcessing(...args)
}));

jest.mock('lib/mobile/native-notifications', () => ({
  clearNoteReceivedNotification: (...args: any[]) => mockClearNoteReceivedNotification(...args)
}));

jest.mock('lib/epoch', () => ({
  reconcileEarnWithdrawals: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('lib/miden/front', () => ({
  useAccount: () => mockAccount,
  useAllBalances: () => ({ data: mockAllBalances, mutate: mockMutateBalances, isLoading: mockBalancesLoading }),
  useAllTokensBaseMetadata: () => ({}),
  useMidenContext: () => ({ signTransaction: mockSignTransaction })
}));

jest.mock('lib/miden/front/claimable-notes', () => ({
  useClaimableNotes: () => ({
    data: mockClaimableNotes,
    isFallback: mockClaimableNotesAreCached,
    mutate: mockMutateClaimableNotes
  })
}));

jest.mock('lib/miden/front/guardian-sync', () => ({
  zustandProvider: { name: 'zustand-provider' }
}));

// The factory owns the state: the token registry reads the platform while it loads, before any
// `let` in this file is initialised.
jest.mock('lib/platform', () => {
  const state = { isExtension: true, isMobile: true };
  return { state, isExtension: () => state.isExtension, isMobile: () => state.isMobile };
});
const mockPlatform: { isExtension: boolean; isMobile: boolean } = jest.requireMock('lib/platform').state;

jest.mock('lib/settings/helpers', () => ({
  isAutoConsumeEnabled: () => mockAutoConsume,
  isDelegateProofEnabled: () => mockDelegateProof
}));

jest.mock('lib/store', () => ({
  useWalletStore: (selector: (s: any) => unknown) => selector({ tokenPrices: mockTokenPrices })
}));

jest.mock('lib/woozie', () => ({
  navigate: (...args: any[]) => mockNavigate(...args)
}));

jest.mock('utils/string', () => ({
  truncateAddress: (addr: string) => (addr ? addr.slice(0, 8) : '')
}));

const makeToken = (tokenId: string, symbol: string, name?: string, balance = 100) => ({
  tokenId,
  balance,
  metadata: { symbol, name }
});

const makeNote = (id: string, faucetId: string, isBeingClaimed = false, swapOrder?: { autoConsume: boolean }) => ({
  id,
  faucetId,
  isBeingClaimed,
  swapOrder
});

// Render + flush the auto-consume effect's chained promises (initiate ->
// Promise.all -> mutate -> dispatch) so assertions see the settled state.
const renderExplore = async () => {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<Explore />);
  });
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  return result;
};

describe('Explore', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    document.documentElement.classList.remove('dark');
    mockFaucetId = 'faucet-native';
    mockAccount = { publicKey: 'mtst1account' };
    mockAllBalances = [];
    mockPortfolioTotal = new BigNumber(0);
    mockClaimableNotes = undefined;
    mockClaimableNotesAreCached = false;
    mockPlatform.isExtension = true;
    mockPlatform.isMobile = true;
    mockAutoConsume = false;
    mockDelegateProof = false;
    mockTokenPrices = {};
    mockBalancesLoading = false;
    mockBaseFee = 0;
    mockInitiateConsumeTransaction.mockResolvedValue(undefined);
    mockMutateBalances.mockResolvedValue(undefined);
    mockMutateClaimableNotes.mockResolvedValue(undefined);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe('base rendering', () => {
    it('renders the page shell, banner, balance card, prompts and asset rows', async () => {
      mockAllBalances = [
        makeToken('faucet-native', 'MIDEN', 'Miden'),
        makeToken('t-btc', 'BTC', 'Bitcoin'),
        makeToken('t-eth', 'ETH')
      ];
      // Prices loaded → the real total renders (the mocked Balance hands 0).
      mockTokenPrices = { MIDEN: { price: 1, change24h: 0, percentageChange24h: 0 } };

      await renderExplore();

      expect(screen.getByTestId('explore-page')).toBeInTheDocument();
      expect(screen.getByTestId('connectivity-banner')).toBeInTheDocument();
      expect(screen.getByTestId('balance-card')).toBeInTheDocument();
      // amount is `toLocalFormat(balance)` with no symbol (the card's unit says USD), and account
      // fields flow through.
      expect(screen.getByTestId('balance-amount')).toHaveTextContent('0');
      expect(screen.getByTestId('balance-amount')).not.toHaveTextContent('$');
      expect(screen.getByTestId('balance-account-id')).toHaveTextContent('mtst1account');
      expect(screen.getByTestId('balance-account-number')).toHaveTextContent('mtst1acc');
      expect(screen.getByTestId('home-prompts')).toHaveTextContent('mtst1account');

      const rows = screen.getAllByTestId('asset-row');
      expect(rows).toHaveLength(3);
      expect(rows[0]).toHaveAttribute('data-token', 'faucet-native');
    });

    it('hands the faucet lifecycle only a live note list, never the cached fallback', async () => {
      // The hook serves last session's saved list first. A faucet baseline taken
      // from it would count any native note newer than that cache as this
      // request's mint arriving, so the funding list stays unloaded until live.
      mockClaimableNotes = [makeNote('note-1', 'faucet-native')];
      mockClaimableNotesAreCached = true;
      await renderExplore();
      expect(screen.getByTestId('home-prompts')).toHaveAttribute('data-funding-notes', 'unloaded');
      // The attention list is unaffected: the pending-notes card may show cached notes.
      expect(screen.getByTestId('home-prompts')).toHaveAttribute('data-note-count', '1');
    });

    it('hands the faucet lifecycle the live note list once it has landed', async () => {
      mockClaimableNotes = [makeNote('note-1', 'faucet-native')];
      mockClaimableNotesAreCached = false;
      await renderExplore();
      expect(screen.getByTestId('home-prompts')).toHaveAttribute('data-funding-notes', '1');
    });

    it('puts the balance card in its loading state until the first balance read completes (#844)', async () => {
      // Right after a recovery the store has no entry for the address yet, so
      // the hook hands back a zero placeholder with `isLoading: true`. The card
      // must show its skeleton, not a "$0.00" that reads as lost funds.
      mockAllBalances = [makeToken('faucet-native', 'MIDEN', 'Miden', 0)];
      mockTokenPrices = { MIDEN: { price: 1, change24h: 0, percentageChange24h: 0 } };
      mockBalancesLoading = true;

      await renderExplore();

      expect(screen.getByTestId('balance-card')).toHaveAttribute('data-state', 'loading');
    });

    it('returns the balance card to its default state once balances have loaded', async () => {
      mockAllBalances = [makeToken('faucet-native', 'MIDEN', 'Miden', 100)];
      mockTokenPrices = { MIDEN: { price: 1, change24h: 0, percentageChange24h: 0 } };
      mockBalancesLoading = false;

      await renderExplore();

      expect(screen.getByTestId('balance-card')).toHaveAttribute('data-state', 'default');
    });

    it('shows a loading row, not the zero placeholder, in Assets until the first balance read completes (#1123)', async () => {
      // The hook hands back a "0 MIDEN" placeholder while nothing has been read. Under a
      // loading card that row still said the imported wallet was empty.
      mockAllBalances = [makeToken('faucet-native', 'MIDEN', 'Miden', 0)];
      mockBalancesLoading = true;

      await renderExplore();

      expect(screen.getByTestId('asset-row-skeleton')).toBeInTheDocument();
      expect(screen.queryAllByTestId('asset-row')).toHaveLength(0);
      expect(screen.getByTestId('asset-list')).toHaveAttribute('aria-busy', 'true');
    });

    it('replaces the loading row with the asset rows once balances have loaded', async () => {
      mockAllBalances = [makeToken('faucet-native', 'MIDEN', 'Miden', 100)];
      mockBalancesLoading = false;

      await renderExplore();

      expect(screen.queryByTestId('asset-row-skeleton')).not.toBeInTheDocument();
      expect(screen.getAllByTestId('asset-row')).toHaveLength(1);
      expect(screen.getByTestId('asset-list')).toHaveAttribute('aria-busy', 'false');
    });

    it('shows the portfolio total as "—" when no prices have loaded, not a fabricated $1-based figure (gap 16)', async () => {
      mockAllBalances = [makeToken('faucet-native', 'MIDEN', 'Miden', 100)];
      mockTokenPrices = {}; // price feed unavailable / not yet loaded

      await renderExplore();

      expect(screen.getByTestId('balance-amount')).toHaveTextContent(/^—$/);
    });

    it('shows the dash placeholder when the account holds tokens and none of them has a price', async () => {
      mockTokenPrices = { ETH: { price: 3000, change24h: 0, percentageChange24h: 0 } };
      mockPortfolioTotal = null;

      await renderExplore();

      expect(screen.getByTestId('balance-amount')).toHaveTextContent(/^\u2014$/);
    });

    // The same rule as the "$-" total above, one row down: a change figure the app does not have is
    // not displayed. Home passed a hardcoded +0.00 / 0.00% before, so the card showed a fabricated
    // zero-change pill on every visit.
    it('passes no change figure until a real price-change source exists', async () => {
      await renderExplore();

      expect(screen.getByTestId('balance-card')).toHaveAttribute('data-delta', 'none');
    });

    it('keeps the native asset first and orders the remaining assets by descending fiat value', async () => {
      mockAllBalances = [
        makeToken('faucet-native', 'MIDEN', 'Miden', 100),
        makeToken('t-eth', 'ETH', 'Ethereum', 1),
        makeToken('t-btc', 'BTC', 'Bitcoin', 2)
      ];
      mockTokenPrices = {
        MIDEN: { price: 1, change24h: 0, percentageChange24h: 0 },
        ETH: { price: 50, change24h: 0, percentageChange24h: 0 },
        BTC: { price: 100, change24h: 0, percentageChange24h: 0 }
      };

      await renderExplore();

      const tokens = screen.getAllByTestId('asset-row').map(row => row.getAttribute('data-token'));
      expect(tokens).toEqual(['faucet-native', 't-btc', 't-eth']);
    });

    it('orders by the price-symbol value, IETH at ETH, and puts tokens with no price after every priced one', async () => {
      mockAllBalances = [
        makeToken('faucet-native', 'MIDEN', 'Miden', 100),
        makeToken('t-other', 'OTH', 'Other', 1000),
        makeToken('t-eth', 'ETH', 'Ethereum', 1),
        makeToken(TOKEN_IETH.faucetId, 'IETH', 'IETH', 0.1)
      ];
      mockTokenPrices = { ETH: { price: 3000, change24h: 0, percentageChange24h: 0 } };

      await renderExplore();

      // ETH 1 * 3000 = 3000, IETH 0.1 * 3000 (its ETH quote) = 300, OTH has no quote at all.
      const tokens = screen.getAllByTestId('asset-row').map(row => row.getAttribute('data-token'));
      expect(tokens).toEqual(['faucet-native', 't-eth', TOKEN_IETH.faucetId, 't-other']);
    });

    it('ranks a token whose scale is unknown as worth nothing, even when its symbol is quoted', async () => {
      mockAllBalances = [
        makeToken('faucet-native', 'MIDEN', 'Miden', 100),
        makeToken('t-eth', 'ETH', 'Ethereum', 1),
        // The placeholder's guessed decimals make this balance meaningless; at the ETH quote it
        // would outrank everything by a factor of a million.
        { tokenId: 't-unsized', balance: 1_000_000, metadata: { symbol: 'ETH', name: 'Unknown', scaleIsUnknown: true } }
      ];
      mockTokenPrices = { ETH: { price: 3000, change24h: 0, percentageChange24h: 0 } };

      await renderExplore();

      const tokens = screen.getAllByTestId('asset-row').map(row => row.getAttribute('data-token'));
      expect(tokens).toEqual(['faucet-native', 't-eth', 't-unsized']);
    });

    it('renders with no asset rows when balances are undefined (destructuring default)', async () => {
      mockAllBalances = undefined;

      await renderExplore();

      expect(screen.getByTestId('explore-page')).toBeInTheDocument();
      expect(screen.queryAllByTestId('asset-row')).toHaveLength(0);
    });

    it('passes the existing claimable notes and token prices to home prompts', async () => {
      mockClaimableNotes = [makeNote('note-1', 'faucet-native')];
      mockTokenPrices = { MIDEN: { price: 2 } };

      await renderExplore();

      expect(screen.getByTestId('home-prompts')).toHaveAttribute('data-note-count', '1');
      expect(screen.getByTestId('home-prompts')).toHaveAttribute('data-price-symbols', 'MIDEN');
    });

    it('keeps notes the page itself auto-consumes out of home prompts (#811)', async () => {
      mockAutoConsume = true;
      mockClaimableNotes = [
        makeNote('auto', 'faucet-native'),
        makeNote('manual', 'other-faucet'),
        makeNote('manual-swap', 'faucet-native', false, { autoConsume: false })
      ];

      await renderExplore();

      expect(screen.getByTestId('home-prompts')).toHaveAttribute('data-note-count', '2');
    });

    it('keeps a native note worth too little to auto-consume on home prompts', async () => {
      mockAutoConsume = true;
      mockBaseFee = 10;
      // One render must drop the note a consume already covers and keep the dust note: a raw list would count three.
      mockClaimableNotes = [
        { ...makeNote('dust', 'faucet-native'), amount: '1' },
        { ...makeNote('claiming', 'faucet-native', true), amount: '1000000' },
        makeNote('manual', 'other-faucet')
      ];

      await renderExplore();

      expect(screen.getByTestId('home-prompts')).toHaveAttribute('data-note-count', '2');
    });
  });

  describe('hex-address redirect', () => {
    it('returns null and navigates to /reset-required when the address is hex', async () => {
      mockAccount = { publicKey: '0xdeadbeef' };
      mockAllBalances = [makeToken('t1', 'AAA')];

      const { container } = await renderExplore();

      // Component early-returns null: no page shell rendered.
      expect(container).toBeEmptyDOMElement();
      expect(screen.queryByTestId('explore-page')).toBeNull();
      expect(mockNavigate).toHaveBeenCalledWith('/reset-required');
    });

    it('does not navigate for a non-hex (bech32) address', async () => {
      mockAccount = { publicKey: 'mtst1account' };

      await renderExplore();

      expect(mockNavigate).not.toHaveBeenCalledWith('/reset-required');
      expect(screen.getByTestId('explore-page')).toBeInTheDocument();
    });
  });

  describe('asset list', () => {
    beforeEach(() => {
      mockAllBalances = [
        makeToken('faucet-native', 'MIDEN', 'Miden'),
        makeToken('t-btc', 'BTC', 'Bitcoin'),
        makeToken('t-eth', 'ETH')
      ];
    });

    it('lists every token under the Assets heading with no search box', async () => {
      await renderExplore();
      expect(screen.getAllByTestId('asset-row')).toHaveLength(3);
      expect(screen.queryByTestId('search-input')).toBeNull();
    });
  });

  describe('HomeOverview interactions', () => {
    beforeEach(() => {
      mockAllBalances = [makeToken('t-abc', 'ABC', 'Alpha')];
    });

    it('opens and closes the accounts drawer via BalanceCard onMore', async () => {
      await renderExplore();

      expect(screen.queryByTestId('accounts-drawer')).toBeNull();

      await act(async () => {
        fireEvent.click(screen.getByTestId('balance-more'));
      });
      expect(screen.getByTestId('accounts-drawer')).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByTestId('drawer-close'));
      });
      expect(screen.queryByTestId('accounts-drawer')).toBeNull();
    });

    it('navigates to the token detail page when an asset row is clicked', async () => {
      await renderExplore();

      await act(async () => {
        fireEvent.click(screen.getByTestId('asset-row'));
      });

      expect(mockNavigate).toHaveBeenCalledWith('/token-detail/t-abc');
    });
  });

  describe('pull to refresh', () => {
    it('refreshes balances and claimable notes after a downward pull from the top', async () => {
      await renderExplore();
      const scroller = screen.getByTestId('explore-scroll-container');

      fireEvent.touchStart(scroller, { touches: [{ clientX: 50, clientY: 0 }] });
      fireEvent.touchMove(scroller, { touches: [{ clientX: 50, clientY: 180 }] });

      expect(screen.getByTestId('pull-to-refresh-indicator').firstChild).toHaveClass('rotate-180');

      fireEvent.touchEnd(scroller, { changedTouches: [{ clientX: 50, clientY: 180 }] });

      await waitFor(() => {
        expect(mockMutateBalances).toHaveBeenCalledTimes(1);
        expect(mockMutateClaimableNotes).toHaveBeenCalledTimes(1);
      });
    });

    it('does not refresh for a short pull', async () => {
      await renderExplore();
      const scroller = screen.getByTestId('explore-scroll-container');

      fireEvent.touchStart(scroller, { touches: [{ clientX: 50, clientY: 0 }] });
      fireEvent.touchMove(scroller, { touches: [{ clientX: 50, clientY: 60 }] });
      fireEvent.touchEnd(scroller, { changedTouches: [{ clientX: 50, clientY: 60 }] });

      expect(mockMutateBalances).not.toHaveBeenCalled();
      expect(mockMutateClaimableNotes).not.toHaveBeenCalled();
    });

    it('does not activate pull to refresh in dark mode', async () => {
      document.documentElement.classList.add('dark');
      await renderExplore();
      const scroller = screen.getByTestId('explore-scroll-container');

      fireEvent.touchStart(scroller, { touches: [{ clientX: 50, clientY: 0 }] });
      fireEvent.touchMove(scroller, { touches: [{ clientX: 50, clientY: 180 }] });
      fireEvent.touchEnd(scroller, { changedTouches: [{ clientX: 50, clientY: 180 }] });

      expect(mockMutateBalances).not.toHaveBeenCalled();
      expect(mockMutateClaimableNotes).not.toHaveBeenCalled();
    });

    it('is disabled outside the mobile app', async () => {
      mockPlatform.isMobile = false;
      await renderExplore();
      const scroller = screen.getByTestId('explore-scroll-container');

      expect(screen.queryByTestId('pull-to-refresh-indicator')).not.toBeInTheDocument();

      fireEvent.touchStart(scroller, { touches: [{ clientX: 50, clientY: 0 }] });
      fireEvent.touchMove(scroller, { touches: [{ clientX: 50, clientY: 180 }] });
      fireEvent.touchEnd(scroller, { changedTouches: [{ clientX: 50, clientY: 180 }] });

      expect(mockMutateBalances).not.toHaveBeenCalled();
      expect(mockMutateClaimableNotes).not.toHaveBeenCalled();
    });
  });

  describe('auto-consume of claimable notes', () => {
    it('does nothing when auto-consume is disabled', async () => {
      mockAutoConsume = false;
      mockClaimableNotes = [makeNote('n1', 'faucet-native')];

      await renderExplore();

      expect(mockInitiateConsumeTransaction).not.toHaveBeenCalled();
      expect(mockRequestSWTransactionProcessing).not.toHaveBeenCalled();
      expect(mockStartBackgroundTransactionProcessing).not.toHaveBeenCalled();
    });

    it('does nothing when auto-consume is enabled but there are no claimable notes', async () => {
      mockAutoConsume = true;
      mockClaimableNotes = undefined; // hits the `!claimableNotes` guard in the memo

      await renderExplore();

      expect(mockInitiateConsumeTransaction).not.toHaveBeenCalled();
    });

    it('does nothing when notes exist but none match the faucet id', async () => {
      mockAutoConsume = true;
      mockClaimableNotes = [makeNote('n1', 'other-faucet')];

      await renderExplore();

      expect(mockInitiateConsumeTransaction).not.toHaveBeenCalled();
    });

    it('never auto-consumes a native note that only the cached list has shown', async () => {
      mockAutoConsume = true;
      mockClaimableNotes = [{ ...makeNote('cached', 'faucet-native'), fromCache: true }];

      await renderExplore();

      expect(mockInitiateConsumeTransaction).not.toHaveBeenCalled();
      expect(mockRequestSWTransactionProcessing).not.toHaveBeenCalled();
      expect(mockStartBackgroundTransactionProcessing).not.toHaveBeenCalled();
    });

    it('leaves native swap notes to the swap settlement path', async () => {
      mockAutoConsume = true;
      mockClaimableNotes = [makeNote('swap-note', 'faucet-native', false, { autoConsume: false })];

      await renderExplore();

      expect(mockInitiateConsumeTransaction).not.toHaveBeenCalled();
      expect(mockRequestSWTransactionProcessing).not.toHaveBeenCalled();
      expect(mockStartBackgroundTransactionProcessing).not.toHaveBeenCalled();
    });

    it('consumes matching, not-yet-claiming notes and dispatches via the SW on extension', async () => {
      mockAutoConsume = true;
      mockDelegateProof = true;
      mockPlatform.isExtension = true;
      mockClaimableNotes = [
        makeNote('n1', 'faucet-native', false), // consumed
        makeNote('n2', 'faucet-native', true), // already claiming -> skipped
        makeNote('n3', 'other-faucet', false) // wrong faucet -> filtered out
      ];

      await renderExplore();

      expect(mockInitiateConsumeTransaction).toHaveBeenCalledTimes(1);
      expect(mockInitiateConsumeTransaction).toHaveBeenCalledWith(
        'mtst1account',
        expect.objectContaining({ id: 'n1' }),
        true // isDelegatedProvingEnabled
      );
      expect(mockMutateClaimableNotes).toHaveBeenCalled();
      expect(mockRequestSWTransactionProcessing).toHaveBeenCalledTimes(1);
      expect(mockStartBackgroundTransactionProcessing).not.toHaveBeenCalled();
    });

    it('clears the stale note-received notification once auto-consume takes over (#459)', async () => {
      mockAutoConsume = true;
      mockDelegateProof = false;
      mockPlatform.isExtension = false;
      mockClaimableNotes = [makeNote('n1', 'faucet-native', false)];

      await renderExplore();

      expect(mockInitiateConsumeTransaction).toHaveBeenCalledTimes(1);
      // The "click to claim" notification is obsolete once the wallet auto-claims
      // the note — dismiss it so it doesn't linger and open to "nothing to claim".
      expect(mockClearNoteReceivedNotification).toHaveBeenCalled();
    });

    it('does not clear the note notification when there is nothing to auto-consume', async () => {
      mockAutoConsume = true;
      mockClaimableNotes = [];

      await renderExplore();

      expect(mockInitiateConsumeTransaction).not.toHaveBeenCalled();
      expect(mockClearNoteReceivedNotification).not.toHaveBeenCalled();
    });

    it('dispatches background processing (with signer + provider) when not an extension', async () => {
      mockAutoConsume = true;
      mockDelegateProof = false;
      mockPlatform.isExtension = false;
      mockClaimableNotes = [makeNote('n1', 'faucet-native', false)];

      await renderExplore();

      expect(mockInitiateConsumeTransaction).toHaveBeenCalledTimes(1);
      expect(mockInitiateConsumeTransaction).toHaveBeenCalledWith(
        'mtst1account',
        expect.objectContaining({ id: 'n1' }),
        false
      );
      expect(mockRequestSWTransactionProcessing).not.toHaveBeenCalled();
      expect(mockStartBackgroundTransactionProcessing).toHaveBeenCalledTimes(1);
      expect(mockStartBackgroundTransactionProcessing).toHaveBeenCalledWith(
        mockSignTransaction,
        false,
        expect.objectContaining({ name: 'zustand-provider' })
      );
    });

    it('skips dispatch when every matching note is already being claimed', async () => {
      mockAutoConsume = true;
      mockClaimableNotes = [makeNote('n1', 'faucet-native', true), makeNote('n2', 'faucet-native', true)];

      await renderExplore();

      // midenNotes is non-empty (so hasAutoConsumableNotes is true and the
      // effect fires), but notesToClaim is empty -> early return before dispatch.
      expect(mockInitiateConsumeTransaction).not.toHaveBeenCalled();
      expect(mockMutateClaimableNotes).not.toHaveBeenCalled();
      expect(mockRequestSWTransactionProcessing).not.toHaveBeenCalled();
      expect(mockStartBackgroundTransactionProcessing).not.toHaveBeenCalled();
    });

    it('consumes multiple matching notes in one pass', async () => {
      mockAutoConsume = true;
      mockClaimableNotes = [makeNote('n1', 'faucet-native', false), makeNote('n2', 'faucet-native', false)];

      await renderExplore();

      expect(mockInitiateConsumeTransaction).toHaveBeenCalledTimes(2);
      const ids = mockInitiateConsumeTransaction.mock.calls.map(c => c[1].id);
      expect(ids).toEqual(expect.arrayContaining(['n1', 'n2']));
    });
  });
});
