import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

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
let mockIsExtension = true;
let mockIsMobile = true;
let mockAutoConsume = false;
let mockDelegateProof = false;
let mockTokenPrices: Record<string, unknown> = {};

const mockSignTransaction = jest.fn();
const mockMutateBalances = jest.fn();
const mockMutateClaimableNotes = jest.fn();
const mockInitiateConsumeTransaction = jest.fn();
const mockReconcileBridgedReceives = jest.fn();
const mockRequestSWTransactionProcessing = jest.fn();
const mockStartBackgroundTransactionProcessing = jest.fn();
const mockSetFaucetIdSetting = jest.fn();
const mockNavigate = jest.fn();

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('app/hooks/useMidenFaucetId', () => ({
  __esModule: true,
  default: () => mockFaucetId
}));

// Balance is a render-prop that hands its child the total fiat BigNumber; the
// child immediately runs it through the (mocked) toLocalFormat, so any value is
// fine here.
jest.mock('app/templates/Balance', () => ({
  __esModule: true,
  default: ({ children }: { children: (b: unknown) => React.ReactElement }) => children(0)
}));

jest.mock('app/templates/HomePrompts', () => ({
  __esModule: true,
  default: ({ account }: { account: { publicKey: string } }) => (
    <div data-testid="home-prompts">{account?.publicKey}</div>
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
  BalanceCard: ({
    accountNumber,
    accountId,
    amount,
    onMore
  }: {
    accountNumber: string;
    accountId: string;
    amount: string;
    onMore: () => void;
  }) => (
    <div data-testid="balance-card">
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
  reconcileBridgedReceives: (...args: any[]) => mockReconcileBridgedReceives(...args),
  requestSWTransactionProcessing: (...args: any[]) => mockRequestSWTransactionProcessing(...args),
  startBackgroundTransactionProcessing: (...args: any[]) => mockStartBackgroundTransactionProcessing(...args)
}));

jest.mock('lib/epoch', () => ({
  reconcileEarnWithdrawals: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('lib/miden/front', () => ({
  setFaucetIdSetting: (...args: any[]) => mockSetFaucetIdSetting(...args),
  useAccount: () => mockAccount,
  useAllBalances: () => ({ data: mockAllBalances, mutate: mockMutateBalances }),
  useAllTokensBaseMetadata: () => ({}),
  useMidenContext: () => ({ signTransaction: mockSignTransaction })
}));

jest.mock('lib/miden/front/claimable-notes', () => ({
  useClaimableNotes: () => ({ data: mockClaimableNotes, mutate: mockMutateClaimableNotes })
}));

jest.mock('lib/miden/front/guardian-sync', () => ({
  zustandProvider: { name: 'zustand-provider' }
}));

jest.mock('lib/miden-chain/constants', () => ({
  MIDEN_NETWORK_NAME: { MAINNET: 'mainnet', TESTNET: 'testnet', DEVNET: 'devnet', LOCALNET: 'localnet' },
  MIDEN_FAUCET_ENDPOINTS: new Map([['devnet', 'https://faucet.devnet.example']])
}));

jest.mock('lib/platform', () => ({
  isExtension: () => mockIsExtension,
  isMobile: () => mockIsMobile
}));

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

const makeToken = (tokenId: string, symbol: string, name?: string) => ({
  tokenId,
  balance: 100,
  metadata: { symbol, name }
});

const makeNote = (id: string, faucetId: string, isBeingClaimed = false) => ({
  id,
  faucetId,
  isBeingClaimed
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
    mockClaimableNotes = undefined;
    mockIsExtension = true;
    mockIsMobile = true;
    mockAutoConsume = false;
    mockDelegateProof = false;
    mockTokenPrices = {};
    mockInitiateConsumeTransaction.mockResolvedValue(undefined);
    mockReconcileBridgedReceives.mockResolvedValue(undefined);
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
        // faucet-native token sorts to the front (ternary -> -1)
        makeToken('faucet-native', 'MIDEN', 'Miden'),
        // non-faucet tokens keep their order (ternary -> 1)
        makeToken('t-btc', 'BTC', 'Bitcoin'),
        makeToken('t-eth', 'ETH')
      ];

      await renderExplore();

      expect(screen.getByTestId('explore-page')).toBeInTheDocument();
      expect(screen.getByTestId('connectivity-banner')).toBeInTheDocument();
      expect(screen.getByTestId('balance-card')).toBeInTheDocument();
      // amount is `$${toLocalFormat(balance)}` and account fields flow through.
      expect(screen.getByTestId('balance-amount')).toHaveTextContent('$0');
      expect(screen.getByTestId('balance-account-id')).toHaveTextContent('mtst1account');
      expect(screen.getByTestId('balance-account-number')).toHaveTextContent('mtst1acc');
      expect(screen.getByTestId('home-prompts')).toHaveTextContent('mtst1account');

      const rows = screen.getAllByTestId('asset-row');
      expect(rows).toHaveLength(3);
      // faucet token was sorted to the front.
      expect(rows[0]).toHaveAttribute('data-token', 'faucet-native');
    });

    it('renders with no asset rows when balances are undefined (destructuring default)', async () => {
      mockAllBalances = undefined;

      await renderExplore();

      expect(screen.getByTestId('explore-page')).toBeInTheDocument();
      expect(screen.queryAllByTestId('asset-row')).toHaveLength(0);
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

  describe('token search filtering', () => {
    beforeEach(() => {
      mockAllBalances = [
        makeToken('faucet-native', 'MIDEN', 'Miden'),
        makeToken('t-btc', 'BTC', 'Bitcoin'),
        makeToken('t-eth', 'ETH') // name is undefined -> optional chaining short-circuits
      ];
    });

    it('shows all tokens (sorted) when the search box is empty', async () => {
      await renderExplore();
      expect(screen.getAllByTestId('asset-row')).toHaveLength(3);
    });

    it('filters by symbol (left match) and name (right match), excluding undefined-name tokens', async () => {
      await renderExplore();

      // query "i": MIDEN symbol matches (left true); BTC symbol misses but
      // "Bitcoin" name matches (right true); ETH symbol misses and name is
      // undefined (right short-circuits to falsy) -> excluded.
      await act(async () => {
        fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'i' } });
      });

      const rows = screen.getAllByTestId('asset-row');
      const tokens = rows.map(r => r.getAttribute('data-token'));
      expect(tokens).toEqual(['faucet-native', 't-btc']);
      expect(tokens).not.toContain('t-eth');
    });

    it('treats a whitespace-only query as empty (trim branch)', async () => {
      await renderExplore();

      await act(async () => {
        fireEvent.change(screen.getByTestId('search-input'), { target: { value: '   ' } });
      });

      expect(screen.getAllByTestId('asset-row')).toHaveLength(3);
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
      mockIsMobile = false;
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

    it('consumes matching, not-yet-claiming notes and dispatches via the SW on extension', async () => {
      mockAutoConsume = true;
      mockDelegateProof = true;
      mockIsExtension = true;
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

    it('dispatches background processing (with signer + provider) when not an extension', async () => {
      mockAutoConsume = true;
      mockDelegateProof = false;
      mockIsExtension = false;
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
