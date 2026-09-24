import React from 'react';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { SharedEarnLocks } from 'lib/epoch/testing/earn-locks';
import type { TokenBalanceData } from 'lib/miden/front';
import { FaucetOutcomeUnknownError } from 'lib/miden-chain/faucet-api';
import type { WalletAccount } from 'lib/shared/types';
import type { PendingNoteValue } from 'lib/wallet-prompts';
import {
  FAUCET_UNSUBMITTED_MARKER_MS,
  FaucetRequestInProgressError,
  WalletPromptStatus,
  WalletPromptType,
  withFaucetFundingMarkerLock
} from 'lib/wallet-prompts';

import { HomePrompts } from './HomePrompts';

const mockFaucet = jest.fn();
const mockGetInFlightFaucetRequest = jest.fn();
const mockGetInFlightFaucetMarker = jest.fn();
const mockGetFaucetRequestSettledAt = jest.fn();
const mockFetchActiveBridgePrompts = jest.fn();
const mockUseWalletPromptStorage = jest.fn();
const mockFetchHotKeyHardwareError = jest.fn();
const mockFetchFaucetFundingMarker = jest.fn();
const mockSetFaucetFundingMarker = jest.fn();
// Backs the two marker mocks by default, so a later read sees what an earlier write
// left behind, as storage would.
const markerStore = new Map<string, unknown>();

let mockBaseFee: number | null = 0;
jest.mock('app/hooks/useVerificationBaseFee', () => ({ __esModule: true, default: () => mockBaseFee }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { amount?: string; count?: number }) => {
      const value = values?.amount ?? values?.count;
      return value === undefined ? key : `${key}:${value}`;
    }
  })
}));

jest.mock('components/ui', () => ({
  PromptCarousel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PromptCard: ({
    title,
    body,
    bodyValue,
    hero,
    onClick,
    actionLabel,
    onAction,
    actionDisabled,
    status,
    onDismiss
  }: {
    title: string;
    body?: string;
    bodyValue?: string;
    hero?: { icon: string; label: string; tone: string };
    onClick?: () => void;
    actionLabel?: string;
    onAction?: () => void;
    actionDisabled?: boolean;
    status?: string;
    onDismiss?: () => void;
  }) => (
    <section
      data-testid="prompt-card"
      data-title={title}
      data-status={status}
      data-hero={hero?.label}
      // The real PromptCard renders no action button at all without onClick, but
      // this double always renders one - so tests must read actionability here,
      // or a removed readiness gate still passes behind fundWallet's own guard.
      data-actionable={onClick ? 'true' : 'false'}
    >
      <button type="button" onClick={onClick}>
        {title}
      </button>
      {body && <p>{body}</p>}
      {bodyValue && <p data-testid="prompt-card-value">{bodyValue}</p>}
      {actionLabel && (
        <button type="button" onClick={onAction} disabled={actionDisabled}>
          {actionLabel}
        </button>
      )}
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label={`dismiss-${title}`}>
          dismiss
        </button>
      )}
    </section>
  )
}));

const mockHiddenNotes = { ids: new Set<string>(), loaded: true, failed: false };
jest.mock('app/hooks/useActivityHiddenNotes', () => ({
  useActivityHiddenNotes: () => ({ ...mockHiddenNotes, hide: jest.fn(), restore: jest.fn() })
}));

jest.mock('lib/wallet-prompts', () => {
  const actual = jest.requireActual('lib/wallet-prompts');
  return {
    ...actual,
    // Persists the marker it is handed, as the real request does before anything can
    // mint (flagging it submitted is covered in wallet-prompts.test.ts).
    faucet: (address: string, marker: unknown) => {
      if (marker) markerStore.set(address, marker);
      return mockFaucet(address, marker);
    },
    getInFlightFaucetRequest: (address: string) => mockGetInFlightFaucetRequest(address),
    getInFlightFaucetMarker: (address: string) => mockGetInFlightFaucetMarker(address),
    getFaucetRequestSettledAt: (address: string, requestedAt: number) =>
      mockGetFaucetRequestSettledAt(address, requestedAt),
    fetchActiveBridgePrompts: (address: string) => mockFetchActiveBridgePrompts(address),
    fetchFaucetFundingMarker: (address: string) => mockFetchFaucetFundingMarker(address),
    setFaucetFundingMarker: (address: string, marker: unknown) => mockSetFaucetFundingMarker(address, marker),
    fetchHotKeyHardwareError: () => mockFetchHotKeyHardwareError(),
    useWalletPromptStorage: () => mockUseWalletPromptStorage()
  };
});

jest.mock('lib/woozie', () => ({ navigate: jest.fn() }));

jest.mock('app/hooks/useMidenFaucetId', () => ({ __esModule: true, default: () => '0xnative' }));

const mockInitiateReplaceHotKeyTransaction = jest.fn();
const mockRequestSWTransactionProcessing = jest.fn();
jest.mock('lib/miden/activity', () => ({
  initiateReplaceHotKeyTransaction: (...args: unknown[]) => mockInitiateReplaceHotKeyTransaction(...args),
  requestSWTransactionProcessing: () => mockRequestSWTransactionProcessing()
}));
jest.mock('lib/miden/front/guardian-sync', () => ({ zustandProvider: { tag: 'zustand-provider' } }));
jest.mock('lib/settings/helpers', () => ({ isDelegateProofEnabled: () => true }));
jest.mock('lib/platform', () => ({ isExtension: () => false }));

const account = {
  publicKey: 'accountA',
  name: 'Account A',
  isPublic: false,
  hdIndex: 0
} as WalletAccount;

const accountB = {
  publicKey: 'accountB',
  name: 'Account B',
  isPublic: false,
  hdIndex: 1
} as WalletAccount;

const zeroBalance = [{ tokenId: 'token', balance: 0 }] as TokenBalanceData[];
const fundedBalance = [{ tokenId: 'token', balance: 1 }] as TokenBalanceData[];
// Must match the mocked useMidenFaucetId above — arrival only counts notes
// minted by the native faucet.
const NATIVE_FAUCET_ID = '0xnative';
const pendingNotes: PendingNoteValue[] = [
  { id: 'note-1', amount: '1250000', faucetId: NATIVE_FAUCET_ID, metadata: { decimals: 6, symbol: 'MIDEN' } },
  { id: 'note-2', amount: '2000000', faucetId: '0xusdc', metadata: { decimals: 6, symbol: 'USDC' } }
];
const nonNativeNotes: PendingNoteValue[] = [
  { id: 'note-usdc-1', amount: '2000000', faucetId: '0xusdc', metadata: { decimals: 6, symbol: 'USDC' } }
];
const tokenPrices = {
  MIDEN: { price: 2, change24h: 0, percentageChange24h: 0 },
  USDC: { price: 1, change24h: 0, percentageChange24h: 0 }
};

// The faucet prompt's status is per account, so its writes are asserted with the
// account they belong to rather than through the wallet-wide prompt spies.
const mockSetFaucetStatus = jest.fn();

const makePromptState = ({ storage, ...overrides }: { storage?: object } & Record<string, unknown> = {}) => ({
  isLoaded: true,
  setPromptStatus: jest.fn(),
  setFaucetStatus: mockSetFaucetStatus,
  dismissPrompt: jest.fn(),
  completePrompt: jest.fn(),
  isPromptPending: (type: WalletPromptType) => type === WalletPromptType.VerifySeedPhrase,
  ...overrides,
  // Merged, so a fixture states only the storage fields its test is about.
  storage: { version: 1, prompts: {}, pendingNotesDismissedIds: [], faucetByAccount: {}, ...storage }
});

describe('HomePrompts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // The hidden (declined) set is module-scoped state, so a test that declines something must
    // not leave it declined for the next one.
    mockHiddenNotes.ids = new Set<string>();
    mockHiddenNotes.loaded = true;
    mockHiddenNotes.failed = false;
    mockFaucet.mockResolvedValue(undefined);
    mockFetchActiveBridgePrompts.mockResolvedValue([]);
    mockFetchHotKeyHardwareError.mockResolvedValue(null);
    markerStore.clear();
    // clearAllMocks keeps a queued once-implementation, and an unused held read must not reach the next test.
    mockFetchFaucetFundingMarker.mockReset();
    mockSetFaucetFundingMarker.mockReset();
    mockFetchFaucetFundingMarker.mockImplementation(async (address: string) => markerStore.get(address) ?? null);
    mockSetFaucetFundingMarker.mockImplementation(async (address: string, marker: unknown) => {
      if (marker === null) markerStore.delete(address);
      else markerStore.set(address, marker);
    });
    mockGetInFlightFaucetRequest.mockReturnValue(null);
    mockGetInFlightFaucetMarker.mockReturnValue(null);
    mockGetFaucetRequestSettledAt.mockReturnValue(null);
    // One lock manager standing in for navigator.locks, which every extension surface shares.
    Object.defineProperty(navigator, 'locks', { configurable: true, value: new SharedEarnLocks() });
  });

  it('shows and dismisses a pending bridge through the wallet prompt type', async () => {
    const dismissPrompt = jest.fn();
    const bridgeTransaction = { id: 'bridge-1', type: 'bridged-send' };
    mockFetchActiveBridgePrompts.mockResolvedValue([bridgeTransaction]);
    mockUseWalletPromptStorage.mockReturnValue(
      makePromptState({
        dismissPrompt,
        storage: {
          version: 1,
          prompts: { [WalletPromptType.Bridge]: WalletPromptStatus.Pending },
          pendingNotesDismissedIds: []
        },
        isPromptPending: (type: WalletPromptType) => type === WalletPromptType.Bridge
      })
    );

    render(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );

    const bridgeCard = await screen.findByText('bridgePromptTitle');
    fireEvent.click(bridgeCard);
    expect(jest.requireMock('lib/woozie').navigate).toHaveBeenCalledWith('/history-details/bridge-1');

    fireEvent.click(screen.getByRole('button', { name: 'dismiss-bridgePromptTitle' }));
    expect(dismissPrompt).toHaveBeenCalledWith(WalletPromptType.Bridge);
  });

  it('shows the faucet prompt before seed verification for a loaded empty account', () => {
    const promptState = makePromptState();
    mockUseWalletPromptStorage.mockReturnValue(promptState);

    render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );

    expect(screen.getAllByTestId('prompt-card').map(card => card.dataset.title)).toEqual([
      'faucetPromptTitle',
      'verifySeedPhrasePromptTitle'
    ]);
    expect(mockSetFaucetStatus).toHaveBeenCalledWith('accountA', WalletPromptStatus.Pending);
  });

  it('re-offers a dismissed faucet prompt once the account can no longer pay a fee', () => {
    // Dismiss means "not now", not "never again". An account that has run its
    // native balance to zero on a fee-charging chain is stuck, and the prompt is
    // the way out -- keeping it hidden strands the user with no affordance.
    mockUseWalletPromptStorage.mockReturnValue(
      makePromptState({
        storage: {
          version: 1,
          prompts: {},
          pendingNotesDismissedIds: [],
          faucetByAccount: { accountA: WalletPromptStatus.Dismissed }
        }
      })
    );
    const renderCard = () => (
      <HomePrompts
        account={account}
        balances={[{ tokenId: NATIVE_FAUCET_ID, balance: 0 }] as TokenBalanceData[]}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    // While fees cost nothing, this account's own dismissal keeps the card away...
    mockBaseFee = 0;
    const { rerender } = render(renderCard());
    expect(screen.queryByText('faucetPromptTitle')).not.toBeInTheDocument();

    // ...and once the account cannot pay a fee, the prompt is back despite it.
    mockBaseFee = 10000;
    rerender(renderCard());
    expect(screen.getByText('faucetPromptTitle')).toBeInTheDocument();
  });

  it('withholds the faucet dismiss control while the account cannot pay a fee', () => {
    // The card re-arms on every render while fee-broke, so a dismiss X would write
    // storage and change nothing: it is withheld, and a per-account dismiss handler
    // must not quietly put it back.
    mockBaseFee = 10000;
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());
    render(
      <HomePrompts
        account={account}
        balances={[{ tokenId: NATIVE_FAUCET_ID, balance: 0 }] as TokenBalanceData[]}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    expect(screen.getByText('faucetPromptTitle')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'dismiss-faucetPromptTitle' })).not.toBeInTheDocument();
  });

  it('still offers the faucet when the account holds tokens but none of the fee asset', () => {
    // Holding USDC is not the same as being funded: the fee comes out of the
    // native balance, so this account cannot transact and needs the faucet.
    mockBaseFee = 10000;
    render(
      <HomePrompts
        account={account}
        balances={
          [
            { tokenId: 'token', balance: 5 },
            { tokenId: NATIVE_FAUCET_ID, balance: 0 }
          ] as TokenBalanceData[]
        }
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    expect(screen.getByText('faucetPromptTitle')).toBeInTheDocument();
  });

  it('still offers Fund on an unfunded account after another account completed its prompt (#921)', () => {
    mockUseWalletPromptStorage.mockReturnValue(
      makePromptState({
        storage: {
          version: 1,
          // An older build stored the faucet status once for the whole wallet...
          prompts: { [WalletPromptType.Faucet]: WalletPromptStatus.Completed },
          pendingNotesDismissedIds: [],
          // ...and account A completed its own.
          faucetByAccount: { accountA: WalletPromptStatus.Completed }
        }
      })
    );

    // A funded account: its card is done.
    const { unmount } = render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    expect(screen.queryByText('faucetPromptTitle')).not.toBeInTheDocument();
    unmount();

    // Account B has never been funded: A's completion must not hide Fund here, and
    // B's own status is seeded for B.
    render(
      <HomePrompts
        account={accountB}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    expect(screen.getByText('faucetPromptTitle')).toBeInTheDocument();
    expect(mockSetFaucetStatus).toHaveBeenCalledWith('accountB', WalletPromptStatus.Pending);
  });

  it('does not show the faucet while balances load or when the account has funds', () => {
    mockUseWalletPromptStorage.mockReturnValue(
      makePromptState({
        storage: {
          version: 1,
          prompts: {},
          pendingNotesDismissedIds: [],
          faucetByAccount: { accountA: WalletPromptStatus.Pending }
        }
      })
    );

    const { rerender } = render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    expect(screen.queryByText('faucetPromptTitle')).not.toBeInTheDocument();

    rerender(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    expect(screen.queryByText('faucetPromptTitle')).not.toBeInTheDocument();
    expect(mockSetFaucetStatus).toHaveBeenCalledWith('accountA', WalletPromptStatus.Completed);
  });

  it('shows the Funding hero in the same render as the tap, before anything is awaited (#923)', async () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());
    render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    const faucetCard = screen.getAllByTestId('prompt-card')[0]!;
    await act(async () => {});

    fireEvent.click(within(faucetCard).getByRole('button', { name: 'faucetPromptTitle' }));

    // No waitFor: PromptCard keeps keyboard focus in the card only for a hero the tap
    // commits before the handler's first await.
    expect(faucetCard).toHaveAttribute('data-hero', 'faucetPromptFunding');
    await waitFor(() => expect(mockFaucet).toHaveBeenCalledTimes(1));
  });

  it('funds on card tap, holds the Funding hero, then plays Funded! and completes when notes arrive', async () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());

    const { rerender } = render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    const faucetCard = screen.getAllByTestId('prompt-card')[0]!;
    // Let this account's funding marker read settle: the card is not offered
    // as actionable until it has.
    await act(async () => {});
    fireEvent.click(within(faucetCard).getByRole('button', { name: 'faucetPromptTitle' }));

    await waitFor(() => expect(mockFaucet).toHaveBeenCalledWith('accountA', expect.anything()));
    expect(mockFaucet).toHaveBeenCalledTimes(1);
    // The faucet ack alone must not complete the prompt — the Funding hero
    // holds until the minted funds are actually visible.
    await waitFor(() => expect(faucetCard).toHaveAttribute('data-hero', 'faucetPromptFunding'));
    expect(faucetCard).toHaveAttribute('data-status', 'loading');
    expect(mockSetFaucetStatus).not.toHaveBeenCalledWith('accountA', WalletPromptStatus.Completed);

    // The minted note becomes claimable → Funded! beat, then completion.
    rerender(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={pendingNotes}
        fundingNotes={pendingNotes}
        tokenPrices={tokenPrices}
      />
    );
    await waitFor(() => expect(faucetCard).toHaveAttribute('data-hero', 'faucetPromptFunded'));
    expect(faucetCard).toHaveAttribute('data-status', 'success');
    // The prompt is completed AT ARRIVAL, while the beat is still on screen: the
    // marker is cleared in the same pass, so deferring completion to the beat's
    // in-memory timer lost it whenever the app closed on this screen.
    expect(mockSetFaucetStatus).toHaveBeenCalledWith('accountA', WalletPromptStatus.Completed);
    // The pending-notes card must hold back while the success beat plays —
    // it sorts first in the carousel and would push the hero off-screen.
    expect(screen.queryByText('pendingNotesPromptTitle')).not.toBeInTheDocument();
    // Beat over (FAUCET_FUNDED_BEAT_MS) → the pending-notes card takes the stage.
    await waitFor(() => expect(screen.getByText('pendingNotesPromptTitle')).toBeInTheDocument(), { timeout: 3500 });
  });

  it("clears only its own request's marker when its funds arrive", async () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());
    // This card resumes the wait for a request that went out a minute ago...
    markerStore.set('accountA', { requestedAt: Date.now() - 60_000, baselineNoteIds: [], submitted: true });
    const { rerender } = render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    await act(async () => {});
    const faucetCard = screen.getAllByTestId('prompt-card')[0]!;
    expect(faucetCard).toHaveAttribute('data-hero', 'faucetPromptFunding');
    // ...while another surface, whose own wait for it ended, has since sent a newer one.
    const newer = { requestedAt: Date.now() - 1_000, baselineNoteIds: [], submitted: true };
    markerStore.set('accountA', newer);

    rerender(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={pendingNotes}
        fundingNotes={pendingNotes}
        tokenPrices={tokenPrices}
      />
    );
    await waitFor(() => expect(faucetCard).toHaveAttribute('data-hero', 'faucetPromptFunded'));
    await act(async () => {});

    expect(markerStore.get('accountA')).toEqual(newer);
  });

  it('plays the Funded! beat and completes when the balance arrives directly', async () => {
    mockUseWalletPromptStorage.mockReturnValue(
      makePromptState({
        storage: {
          version: 1,
          prompts: {},
          pendingNotesDismissedIds: [],
          faucetByAccount: { accountA: WalletPromptStatus.Pending }
        }
      })
    );

    const { rerender } = render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    const faucetCard = screen.getAllByTestId('prompt-card')[0]!;
    // Let this account's funding marker read settle: the card is not offered
    // as actionable until it has.
    await act(async () => {});
    fireEvent.click(within(faucetCard).getByRole('button', { name: 'faucetPromptTitle' }));
    await waitFor(() => expect(mockFaucet).toHaveBeenCalledWith('accountA', expect.anything()));
    expect(mockSetFaucetStatus).not.toHaveBeenCalledWith('accountA', WalletPromptStatus.Completed);

    rerender(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    await waitFor(() => expect(faucetCard).toHaveAttribute('data-hero', 'faucetPromptFunded'));
    await waitFor(() => expect(mockSetFaucetStatus).toHaveBeenCalledWith('accountA', WalletPromptStatus.Completed), {
      timeout: 3000
    });
  });

  it('resumes the Funding hero from a persisted marker after a remount mid-wait', async () => {
    mockFetchFaucetFundingMarker.mockResolvedValue({
      requestedAt: Date.now() - 5_000,
      baselineNoteIds: [],
      submitted: true
    });
    mockUseWalletPromptStorage.mockReturnValue(
      makePromptState({
        storage: {
          version: 1,
          prompts: {},
          pendingNotesDismissedIds: [],
          faucetByAccount: { accountA: WalletPromptStatus.Pending }
        }
      })
    );

    const { rerender } = render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    const faucetCard = screen.getAllByTestId('prompt-card')[0]!;
    // No tap happened this session — the hero resumes from the marker alone.
    await waitFor(() => expect(faucetCard).toHaveAttribute('data-hero', 'faucetPromptFunding'));
    expect(mockFaucet).not.toHaveBeenCalled();

    // Funds land → success beat plays and the marker is cleared.
    rerender(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={pendingNotes}
        fundingNotes={pendingNotes}
        tokenPrices={tokenPrices}
      />
    );
    await waitFor(() => expect(faucetCard).toHaveAttribute('data-hero', 'faucetPromptFunded'));
    expect(mockSetFaucetFundingMarker).toHaveBeenCalledWith('accountA', null);
    await waitFor(() => expect(mockSetFaucetStatus).toHaveBeenCalledWith('accountA', WalletPromptStatus.Completed), {
      timeout: 3500
    });
  });

  it('keeps one account Funding wait off another account and resumes it on switch-back', async () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());

    const { rerender } = render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    const faucetCard = screen.getAllByTestId('prompt-card')[0]!;
    // Let this account's funding marker read settle: the card is not offered
    // as actionable until it has.
    await act(async () => {});
    fireEvent.click(within(faucetCard).getByRole('button', { name: 'faucetPromptTitle' }));
    await waitFor(() => expect(faucetCard).toHaveAttribute('data-hero', 'faucetPromptFunding'));

    // Switching to another (also unfunded) account must show ITS actionable
    // card, not account A's Funding hero…
    rerender(
      <HomePrompts
        account={accountB}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    const cardOnB = screen.getAllByTestId('prompt-card')[0]!;
    await waitFor(() => expect(cardOnB).not.toHaveAttribute('data-hero'));
    expect(cardOnB).toHaveAttribute('data-title', 'faucetPromptTitle');
    // …consulting B's own marker, and never clearing A's still-in-flight one.
    await waitFor(() => expect(mockFetchFaucetFundingMarker).toHaveBeenCalledWith('accountB'));
    expect(mockSetFaucetFundingMarker).not.toHaveBeenCalledWith('accountA', null);

    // Switching back resumes A's wait from A's own persisted marker.
    mockFetchFaucetFundingMarker.mockImplementation((address: string) =>
      address === 'accountA'
        ? Promise.resolve({ requestedAt: Date.now() - 5_000, baselineNoteIds: [], submitted: true })
        : Promise.resolve(null)
    );
    rerender(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    await waitFor(() =>
      expect(screen.getAllByTestId('prompt-card')[0]!).toHaveAttribute('data-hero', 'faucetPromptFunding')
    );
    expect(mockFaucet).toHaveBeenCalledTimes(1);
  });

  it('does not treat a pre-existing claimable note as the faucet mint landing', async () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());
    const preexistingNote = pendingNotes[0]!;

    const { rerender } = render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[preexistingNote]}
        fundingNotes={[preexistingNote]}
        tokenPrices={tokenPrices}
      />
    );
    const faucetCard = screen.getAllByTestId('prompt-card').find(card => card.dataset.title === 'faucetPromptTitle')!;
    // Let this account's funding marker read settle: the card is not offered
    // as actionable until it has.
    await act(async () => {});
    fireEvent.click(within(faucetCard).getByRole('button', { name: 'faucetPromptTitle' }));

    // The note that already existed at request time must NOT flip the card
    // straight to success — the Funding hero holds.
    await waitFor(() => expect(faucetCard).toHaveAttribute('data-hero', 'faucetPromptFunding'));
    await act(async () => {});
    expect(faucetCard).toHaveAttribute('data-hero', 'faucetPromptFunding');
    expect(mockSetFaucetStatus).not.toHaveBeenCalledWith('accountA', WalletPromptStatus.Completed);

    // Only a NEW note (beyond the request-time baseline) lands the funds.
    rerender(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[preexistingNote, { ...pendingNotes[0]!, id: 'minted-note' }]}
        fundingNotes={[preexistingNote, { ...pendingNotes[0]!, id: 'minted-note' }]}
        tokenPrices={tokenPrices}
      />
    );
    await waitFor(() => expect(faucetCard).toHaveAttribute('data-hero', 'faucetPromptFunded'));
  });

  it('caps the backstop at three minutes when the clock steps backwards', async () => {
    jest.useFakeTimers();
    try {
      const base = Date.now();
      // A backward wall-clock step (NTP correction, manual change) leaves the
      // persisted `requestedAt` ten minutes in the FUTURE, so the raw
      // `requestedAt + TIMEOUT - now` delay is 13 minutes. Unclamped, the hero -
      // and the pending-notes suppression with it - holds for all of it.
      // Only the FIRST read returns the marker; the backstop clears it.
      mockFetchFaucetFundingMarker.mockResolvedValue(null);
      mockFetchFaucetFundingMarker.mockResolvedValueOnce({ requestedAt: base, baselineNoteIds: [], submitted: true });
      mockUseWalletPromptStorage.mockReturnValue(makePromptState());
      jest.setSystemTime(base - 10 * 60_000);

      render(
        <HomePrompts
          account={account}
          balances={zeroBalance}
          balancesLoading={false}
          claimableNotes={[]}
          fundingNotes={[]}
          tokenPrices={{}}
        />
      );
      const faucetCard = screen.getAllByTestId('prompt-card')[0]!;
      await act(async () => {});
      expect(faucetCard).toHaveAttribute('data-hero', 'faucetPromptFunding');

      // Just past the 3-minute ceiling the backstop must have fired anyway.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(3 * 60_000 + 1_000);
      });

      expect(screen.getAllByTestId('prompt-card')[0]!).not.toHaveAttribute('data-hero', 'faucetPromptFunding');
    } finally {
      jest.useRealTimers();
    }
  });

  it('ends a resumed wait three minutes after the original request, not after the remount', async () => {
    jest.useFakeTimers();
    try {
      // The marker is already 2:50 old at remount.
      mockFetchFaucetFundingMarker.mockResolvedValue({
        requestedAt: Date.now() - 170_000,
        baselineNoteIds: [],
        submitted: true
      });
      mockUseWalletPromptStorage.mockReturnValue(makePromptState());

      render(
        <HomePrompts
          account={account}
          balances={zeroBalance}
          balancesLoading={false}
          claimableNotes={[]}
          fundingNotes={[]}
          tokenPrices={{}}
        />
      );
      const faucetCard = screen.getAllByTestId('prompt-card')[0]!;
      // Flush the resume fetch so the hero comes up.
      await act(async () => {});
      expect(faucetCard).toHaveAttribute('data-hero', 'faucetPromptFunding');

      // Three minutes after the REQUEST is only ~10s away — the backstop must
      // fire then, not three minutes from this mount.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(11_000);
      });
      expect(faucetCard).not.toHaveAttribute('data-hero');
      expect(mockSetFaucetFundingMarker).toHaveBeenCalledWith('accountA', null);
    } finally {
      jest.useRealTimers();
    }
  });

  it('shows a failure state and allows the faucet request to be retried by tapping again', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockFaucet.mockRejectedValueOnce(new Error('rate limited')).mockResolvedValueOnce(undefined);
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());

    render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    // Let this account's funding marker read settle: the card is not offered
    // as actionable until it has.
    await act(async () => {});
    const faucetCard = screen.getAllByTestId('prompt-card')[0]!;
    const card = within(faucetCard).getByRole('button', { name: 'faucetPromptTitle' });

    fireEvent.click(card);
    await waitFor(() => expect(faucetCard).toHaveAttribute('data-status', 'failure'));
    // The failure must carry the faucet's ACTUAL message — a bare red X can't
    // distinguish a rate limit from an outage (#425).
    expect(faucetCard).toHaveTextContent('rate limited');
    // A failed request clears its pre-persisted marker so nothing resumes it.
    await waitFor(() => expect(mockSetFaucetFundingMarker).toHaveBeenCalledWith('accountA', null));
    fireEvent.click(card);

    await waitFor(() => expect(mockFaucet).toHaveBeenCalledTimes(2));
    // Retrying clears the previous error from the card.
    expect(faucetCard).not.toHaveTextContent('rate limited');
  });

  it('still completes the prompt when the account is switched during the Funded beat', async () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());

    const { rerender } = render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    // Let this account's funding marker read settle: the card is not offered
    // as actionable until it has.
    await act(async () => {});
    fireEvent.click(
      within(screen.getAllByTestId('prompt-card')[0]!).getByRole('button', { name: 'faucetPromptTitle' })
    );
    await waitFor(() =>
      expect(screen.getAllByTestId('prompt-card')[0]!).toHaveAttribute('data-hero', 'faucetPromptFunding')
    );

    // The native mint lands: the Funded beat starts its completion timer.
    rerender(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={pendingNotes}
        fundingNotes={pendingNotes}
        tokenPrices={tokenPrices}
      />
    );
    await waitFor(() =>
      expect(screen.getAllByTestId('prompt-card')[0]!).toHaveAttribute('data-hero', 'faucetPromptFunded')
    );

    // Switch away mid-beat. Resetting an untagged arrival flag here cancelled
    // the timer, leaving the prompt Pending and re-offering Fund for funds that
    // had already landed.
    rerender(
      <HomePrompts
        account={accountB}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );

    await waitFor(() => expect(mockSetFaucetStatus).toHaveBeenCalledWith('accountA', WalletPromptStatus.Completed), {
      timeout: 3500
    });
  });

  it('does not offer the Fund card as actionable until the claimable notes have loaded', async () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());

    const { rerender } = render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={undefined}
        fundingNotes={undefined}
        tokenPrices={{}}
      />
    );
    // Let the marker read settle, so the notes are the only gate left.
    await act(async () => {});
    const faucetCard = () =>
      screen.getAllByTestId('prompt-card').find(card => card.dataset.title === 'faucetPromptTitle')!;
    // The baseline can't be snapshotted yet, so the card has no action at all -
    // not a tap it would silently drop behind a confirming haptic.
    expect(faucetCard()).toHaveAttribute('data-actionable', 'false');

    rerender(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={pendingNotes}
        fundingNotes={pendingNotes}
        tokenPrices={tokenPrices}
      />
    );
    expect(faucetCard()).toHaveAttribute('data-actionable', 'true');
    fireEvent.click(within(faucetCard()).getByRole('button', { name: 'faucetPromptTitle' }));
    await waitFor(() => expect(mockFaucet).toHaveBeenCalledTimes(1));
    expect(mockFaucet).toHaveBeenCalledWith(
      'accountA',
      expect.objectContaining({ baselineNoteIds: pendingNotes.map(note => note.id) })
    );
  });

  it('does not start a mint while the funding marker for this account is still being read', async () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());
    // A mint that acked before a remount has no in-flight join left; only the
    // persisted marker says it is still inbound. Until that read settles, a tap
    // must not be able to start a second real mint.
    let settleRead!: (marker: { requestedAt: number; baselineNoteIds: string[]; submitted?: true } | null) => void;
    mockFetchFaucetFundingMarker.mockImplementation(
      () =>
        new Promise(resolve => {
          settleRead = resolve;
        })
    );

    render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    // While the read is pending the card offers no action at all.
    expect(screen.getAllByTestId('prompt-card')[0]!).toHaveAttribute('data-actionable', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'faucetPromptTitle' }));
    expect(mockFaucet).not.toHaveBeenCalled();

    // The read lands and says a mint is still on its way: the wait resumes and
    // the card becomes the Funding hero, never an actionable Fund card.
    await act(async () => {
      settleRead({ requestedAt: Date.now() - 10_000, baselineNoteIds: [], submitted: true });
    });
    await waitFor(() =>
      expect(screen.getAllByTestId('prompt-card')[0]!).toHaveAttribute('data-hero', 'faucetPromptFunding')
    );
    fireEvent.click(screen.getByRole('button', { name: 'faucetPromptTitle' }));
    expect(mockFaucet).not.toHaveBeenCalled();
  });

  it('treats a balance as arrival even while the claimable notes are still loading', async () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());
    // Resume a wait whose notes never load: only the balance can signal arrival.
    mockFetchFaucetFundingMarker.mockResolvedValue({
      requestedAt: Date.now() - 10_000,
      baselineNoteIds: [],
      submitted: true
    });

    const { rerender } = render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={undefined}
        fundingNotes={undefined}
        tokenPrices={{}}
      />
    );
    await waitFor(() =>
      expect(screen.getAllByTestId('prompt-card')[0]!).toHaveAttribute('data-hero', 'faucetPromptFunding')
    );

    rerender(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={undefined}
        fundingNotes={undefined}
        tokenPrices={{}}
      />
    );

    // Spendable funds are visible - the beat plays instead of holding the
    // Funding hero toward the 3-minute backstop until the notes happen to load.
    await waitFor(() =>
      expect(screen.getAllByTestId('prompt-card')[0]!).toHaveAttribute('data-hero', 'faucetPromptFunded')
    );
  });

  it('sees the faucet mint land even though auto-consume hides it from the attention list', async () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());

    const { rerender } = render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    await act(async () => {});
    fireEvent.click(
      within(screen.getAllByTestId('prompt-card')[0]!).getByRole('button', { name: 'faucetPromptTitle' })
    );
    await waitFor(() =>
      expect(screen.getAllByTestId('prompt-card')[0]!).toHaveAttribute('data-hero', 'faucetPromptFunding')
    );

    // With auto-consume on (the default) Explore's attention list drops the
    // native note the auto-consumer is about to claim - which is the faucet's
    // own mint. Only the unfiltered list carries it. Grading arrival against the
    // attention list never saw the mint land.
    rerender(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={pendingNotes}
        tokenPrices={tokenPrices}
      />
    );

    await waitFor(() =>
      expect(screen.getAllByTestId('prompt-card')[0]!).toHaveAttribute('data-hero', 'faucetPromptFunded')
    );
  });

  it('re-gates Fund on every visit, so A -> B -> A cannot reuse a stale marker read', async () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());
    const renderFor = (who: WalletAccount) => (
      <HomePrompts
        account={who}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );

    const { rerender } = render(renderFor(account));
    await act(async () => {});
    expect(screen.getAllByTestId('prompt-card')[0]!).toHaveAttribute('data-actionable', 'true');

    // From here every marker read hangs: A's second visit must wait for its own.
    mockFetchFaucetFundingMarker.mockImplementation(() => new Promise(() => {}));
    rerender(renderFor(accountB));
    await act(async () => {});
    rerender(renderFor(account));
    await act(async () => {});

    // An address-only proof from A's FIRST visit would re-expose Fund here,
    // before the marker that may say a mint is still inbound has been re-read.
    expect(screen.getAllByTestId('prompt-card')[0]!).toHaveAttribute('data-actionable', 'false');
  });

  it('keeps a failure retryable when the request fails before the marker read settles', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());
    // A remount re-attaches to a request still running at module scope, and the
    // marker read never settles before that request fails.
    let rejectInFlight!: (error: Error) => void;
    mockGetInFlightFaucetRequest.mockReturnValue(
      new Promise<void>((_resolve, reject) => {
        rejectInFlight = reject;
      })
    );
    mockFetchFaucetFundingMarker.mockImplementation(() => new Promise(() => {}));

    render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    await act(async () => {
      rejectInFlight(new Error('rate limited'));
    });

    const card = screen.getAllByTestId('prompt-card')[0]!;
    await waitFor(() => expect(card).toHaveAttribute('data-status', 'failure'));
    // A failure clears the marker, so there is nothing left to resume: the card
    // must offer a retry rather than dead-end on a read that was cancelled.
    await waitFor(() => expect(card).toHaveAttribute('data-actionable', 'true'));
  });

  it('does not carry a failure from one account into the next account visit', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());
    mockFaucet.mockRejectedValueOnce(new Error('rate limited'));
    const renderFor = (who: WalletAccount) => (
      <HomePrompts
        account={who}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );

    const { rerender } = render(renderFor(account));
    await act(async () => {});
    fireEvent.click(
      within(screen.getAllByTestId('prompt-card')[0]!).getByRole('button', { name: 'faucetPromptTitle' })
    );
    await waitFor(() => expect(screen.getAllByTestId('prompt-card')[0]!).toHaveAttribute('data-status', 'failure'));

    // Switch to B, whose marker read never settles. A's failure used to be reset
    // only after commit, so B's first commit read it: that settled B's readiness
    // without a read and painted A's error on B's card.
    mockFetchFaucetFundingMarker.mockImplementation(() => new Promise(() => {}));
    rerender(renderFor(accountB));
    await act(async () => {});

    const card = screen.getAllByTestId('prompt-card')[0]!;
    expect(card).toHaveAttribute('data-actionable', 'false');
    expect(card).not.toHaveAttribute('data-status', 'failure');
    expect(card).not.toHaveTextContent('rate limited');
  });

  it('does not let a delayed request settling overwrite the wait another account started', async () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());
    // A's request hangs; B's resolves. fundingWait is a single slot.
    let persistA!: () => void;
    mockFaucet.mockImplementation((address: string) =>
      address === 'accountA'
        ? new Promise<void>(resolve => {
            persistA = () => resolve();
          })
        : Promise.resolve()
    );
    const renderFor = (who: WalletAccount) => (
      <HomePrompts
        account={who}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );

    const { rerender } = render(renderFor(account));
    await act(async () => {});
    fireEvent.click(
      within(screen.getAllByTestId('prompt-card')[0]!).getByRole('button', { name: 'faucetPromptTitle' })
    );

    // Switch to B and fund B while A's write is still pending.
    rerender(renderFor(accountB));
    await act(async () => {});
    fireEvent.click(
      within(screen.getAllByTestId('prompt-card')[0]!).getByRole('button', { name: 'faucetPromptTitle' })
    );
    await waitFor(() =>
      expect(screen.getAllByTestId('prompt-card')[0]!).toHaveAttribute('data-hero', 'faucetPromptFunding')
    );

    // A's request finally settles. Installing A's wait now would evict B's,
    // dropping B's arrival, success beat and backstop.
    await act(async () => {
      persistA();
    });
    await act(async () => {});

    expect(screen.getAllByTestId('prompt-card')[0]!).toHaveAttribute('data-hero', 'faucetPromptFunding');
  });

  it('logs a marker clear that fails when the backstop fires', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      mockUseWalletPromptStorage.mockReturnValue(makePromptState());
      markerStore.set('accountA', { requestedAt: Date.now() - 170_000, baselineNoteIds: [], submitted: true });
      mockSetFaucetFundingMarker.mockRejectedValue(new Error('storage unavailable'));

      render(
        <HomePrompts
          account={account}
          balances={zeroBalance}
          balancesLoading={false}
          claimableNotes={[]}
          fundingNotes={[]}
          tokenPrices={{}}
        />
      );
      await act(async () => {});
      await act(async () => {
        await jest.advanceTimersByTimeAsync(11_000);
      });

      // Every other marker clear in this file logs; a silent failure here left an
      // orphaned marker with no trail.
      expect(warn).toHaveBeenCalledWith('[wallet-prompts] failed to clear faucet funding marker:', expect.any(Error));
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the prompt completed when the app closes during the Funds deposited beat', async () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());
    const renderIt = (notes: typeof pendingNotes) => (
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={notes}
        fundingNotes={notes}
        tokenPrices={tokenPrices}
      />
    );

    const { rerender, unmount } = render(renderIt([]));
    await act(async () => {});
    fireEvent.click(
      within(screen.getAllByTestId('prompt-card')[0]!).getByRole('button', { name: 'faucetPromptTitle' })
    );
    await waitFor(() =>
      expect(screen.getAllByTestId('prompt-card')[0]!).toHaveAttribute('data-hero', 'faucetPromptFunding')
    );

    rerender(renderIt(pendingNotes));
    await waitFor(() =>
      expect(screen.getAllByTestId('prompt-card')[0]!).toHaveAttribute('data-hero', 'faucetPromptFunded')
    );

    // The user closes the app on the success screen, well inside the beat. The
    // marker is already cleared at arrival, so the prompt must already be complete
    // - a completion held for the beat's in-memory timer would be lost here, and
    // the next open would re-offer Fund for a mint that has landed.
    unmount();
    expect(mockSetFaucetStatus).toHaveBeenCalledWith('accountA', WalletPromptStatus.Completed);
  });

  it('does not re-offer Fund after completion while the minted note is still claimable', async () => {
    // A fee-charging chain: main's fee-broke re-arm shows the card again after
    // completion, until the minted native note is consumed into the balance.
    mockBaseFee = 10000;
    mockUseWalletPromptStorage.mockReturnValue(
      makePromptState({
        storage: {
          version: 1,
          prompts: {},
          pendingNotesDismissedIds: [],
          faucetByAccount: { accountA: WalletPromptStatus.Completed }
        }
      })
    );

    render(
      <HomePrompts
        account={account}
        balances={[{ tokenId: NATIVE_FAUCET_ID, balance: 0 }] as TokenBalanceData[]}
        balancesLoading={false}
        claimableNotes={pendingNotes}
        fundingNotes={pendingNotes}
        tokenPrices={tokenPrices}
      />
    );
    await act(async () => {});

    const faucetCard = screen.getAllByTestId('prompt-card').find(card => card.dataset.title === 'faucetPromptTitle')!;
    // The card is re-armed and visible (the user cannot pay a fee yet)...
    expect(faucetCard).toBeInTheDocument();
    // ...but offering Fund would start a second real mint for funds already here.
    expect(faucetCard).toHaveAttribute('data-actionable', 'false');
  });

  it('keeps waiting instead of offering a retry when the mint request outcome is unknown (#919)', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());
    // The token request went out and was never answered: the faucet may have
    // minted, and a retry would mint a second time.
    mockFaucet.mockRejectedValueOnce(new FaucetOutcomeUnknownError('Faucet token request got no response'));

    render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    await act(async () => {});
    fireEvent.click(
      within(screen.getAllByTestId('prompt-card')[0]!).getByRole('button', { name: 'faucetPromptTitle' })
    );
    await waitFor(() => expect(mockFaucet).toHaveBeenCalledTimes(1));
    await act(async () => {});

    const card = screen.getAllByTestId('prompt-card')[0]!;
    // Still Funding, never a failure with a retry...
    expect(card).toHaveAttribute('data-hero', 'faucetPromptFunding');
    expect(card).not.toHaveAttribute('data-status', 'failure');
    expect(card).toHaveAttribute('data-actionable', 'false');
    // ...and the flagged marker stays, so a remount keeps waiting too.
    expect(mockSetFaucetFundingMarker).not.toHaveBeenCalledWith('accountA', null);
  });

  it('offers Fund when the marker cannot be read (#936)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      mockUseWalletPromptStorage.mockReturnValue(makePromptState());
      // Storage refuses the read this mount makes, so nothing here knows whether a
      // request is on its way.
      mockFetchFaucetFundingMarker.mockRejectedValueOnce(new Error('storage unreadable'));
      render(
        <HomePrompts
          account={account}
          balances={zeroBalance}
          balancesLoading={false}
          claimableNotes={[]}
          fundingNotes={[]}
          tokenPrices={{}}
        />
      );
      await act(async () => {});

      // Fund is offered rather than withheld for as long as storage stays broken (#504).
      // Safe because a tap re-reads the marker before any proof of work, which is where
      // an unreadable marker or a request already on its way refuses it; that read is
      // covered in wallet-prompts.test.ts, since this file mocks the faucet.
      expect(warn).toHaveBeenCalledWith(
        '[wallet-prompts] failed to read faucet funding marker; offering Fund for',
        'accountA',
        expect.any(Error)
      );
      const card = screen.getAllByTestId('prompt-card').find(one => one.dataset.title === 'faucetPromptTitle')!;
      expect(card).toHaveAttribute('data-actionable', 'true');
      expect(card).not.toHaveAttribute('data-hero', 'faucetPromptFunding');
    } finally {
      warn.mockRestore();
    }
  });

  it("waits for another surface's live request instead of failing when a tap is refused over it", async () => {
    jest.useFakeTimers();
    try {
      mockUseWalletPromptStorage.mockReturnValue(makePromptState());
      render(
        <HomePrompts
          account={account}
          balances={zeroBalance}
          balancesLoading={false}
          claimableNotes={[]}
          fundingNotes={[]}
          tokenPrices={{}}
        />
      );
      await act(async () => {});
      // Another surface sent a request after this card read no marker, so the tap is refused.
      const running = { requestedAt: Date.now() - 20_000, baselineNoteIds: [], submitted: true as const };
      mockFaucet.mockImplementationOnce(async () => {
        markerStore.set('accountA', running);
        throw new FaucetRequestInProgressError(running);
      });
      fireEvent.click(
        within(screen.getAllByTestId('prompt-card')[0]!).getByRole('button', { name: 'faucetPromptTitle' })
      );
      await act(async () => {});

      const card = screen.getAllByTestId('prompt-card')[0]!;
      expect(card).toHaveAttribute('data-hero', 'faucetPromptFunding');
      expect(card).not.toHaveAttribute('data-status', 'failure');
      expect(card).toHaveAttribute('data-actionable', 'false');
      expect(mockSetFaucetFundingMarker).not.toHaveBeenCalledWith('accountA', null);

      // The card waits through that request's arrival window (it went out 20s ago), past
      // an unsent request's own deadline, and gives Fund back once the window has passed.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(70_000);
      });
      expect(screen.getAllByTestId('prompt-card')[0]).toHaveAttribute('data-hero', 'faucetPromptFunding');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(3 * 60_000 - 20_000 - 70_000 + 1_000);
      });
      expect(screen.getAllByTestId('prompt-card')[0]).not.toHaveAttribute('data-hero', 'faucetPromptFunding');
    } finally {
      jest.useRealTimers();
    }
  });

  it('waits from the settle this realm recorded when a tap is refused over a request it saw go out', async () => {
    jest.useFakeTimers();
    try {
      mockUseWalletPromptStorage.mockReturnValue(makePromptState());
      render(
        <HomePrompts
          account={account}
          balances={zeroBalance}
          balancesLoading={false}
          claimableNotes={[]}
          fundingNotes={[]}
          tokenPrices={{}}
        />
      );
      await act(async () => {});
      // Sent long ago but settled here only a minute ago: its window runs from that settle.
      const running = {
        requestedAt: Date.now() - 200_000,
        baselineNoteIds: [],
        submitted: true as const,
        submittedAt: Date.now() - 195_000
      };
      const settledAt = Date.now() - 60_000;
      mockGetFaucetRequestSettledAt.mockImplementation((_address: string, requestedAt: number) =>
        requestedAt === running.requestedAt ? settledAt : null
      );
      mockFaucet.mockImplementationOnce(async () => {
        markerStore.set('accountA', running);
        throw new FaucetRequestInProgressError(running);
      });
      fireEvent.click(
        within(screen.getAllByTestId('prompt-card')[0]!).getByRole('button', { name: 'faucetPromptTitle' })
      );
      await act(async () => {});

      await act(async () => {
        await jest.advanceTimersByTimeAsync(60_000);
      });
      expect(screen.getAllByTestId('prompt-card')[0]).toHaveAttribute('data-hero', 'faucetPromptFunding');
    } finally {
      jest.useRealTimers();
    }
  });

  it("waits for another surface's live request when a request this card joined is refused over it", async () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());
    const running = { requestedAt: Date.now() - 20_000, baselineNoteIds: [], submitted: true as const };
    let refuse = () => {};
    mockGetInFlightFaucetRequest.mockReturnValue(
      new Promise<void>((_resolve, reject) => {
        refuse = () => reject(new FaucetRequestInProgressError(running));
      })
    );
    mockGetInFlightFaucetMarker.mockReturnValue({ requestedAt: Date.now() - 1_000, baselineNoteIds: [] });

    render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    await act(async () => {});
    mockGetInFlightFaucetRequest.mockReturnValue(null);
    await act(async () => {
      refuse();
    });

    const card = screen.getAllByTestId('prompt-card')[0]!;
    expect(card).toHaveAttribute('data-hero', 'faucetPromptFunding');
    expect(card).not.toHaveAttribute('data-status', 'failure');
    expect(card).toHaveAttribute('data-actionable', 'false');
  });

  describe('another surface writing the marker while this card decides to clear it (#935)', () => {
    // This card's read of the marker answers late, with the record as it was when asked.
    const holdNextMarkerRead = () => {
      const hold = { requested: false, release: () => {} };
      mockFetchFaucetFundingMarker.mockImplementationOnce((address: string) => {
        hold.requested = true;
        const snapshot = markerStore.get(address) ?? null;
        return new Promise(resolve => {
          hold.release = () => resolve(snapshot);
        });
      });
      return hold;
    };
    // The card read the marker, cleared it, and only then did the other surface's write land.
    const expectClearedBefore = (sent: object) => {
      expect(mockSetFaucetFundingMarker).toHaveBeenCalledWith('accountA', null);
      expect(markerStore.get('accountA')).toEqual(sent);
    };
    const anotherSurfaceSends = () => {
      const sent = { requestedAt: Date.now(), baselineNoteIds: [], submitted: true, submittedAt: Date.now() };
      const write = withFaucetFundingMarkerLock('accountA', async () => {
        markerStore.set('accountA', sent);
      });
      return { sent, write };
    };
    const renderCard = () =>
      render(
        <HomePrompts
          account={account}
          balances={zeroBalance}
          balancesLoading={false}
          claimableNotes={[]}
          fundingNotes={[]}
          tokenPrices={{}}
        />
      );

    it('keeps it when resuming finds an abandoned marker', async () => {
      mockUseWalletPromptStorage.mockReturnValue(makePromptState());
      markerStore.set('accountA', {
        requestedAt: Date.now() - FAUCET_UNSUBMITTED_MARKER_MS - 5_000,
        baselineNoteIds: []
      });
      const read = holdNextMarkerRead();
      renderCard();
      await act(async () => {});
      expect(read.requested).toBe(true);

      const { sent, write } = anotherSurfaceSends();
      await act(async () => {});
      await act(async () => {
        read.release();
        await write;
      });

      expectClearedBefore(sent);
    });

    it("keeps it when this card's own request fails", async () => {
      mockUseWalletPromptStorage.mockReturnValue(makePromptState());
      renderCard();
      await act(async () => {});
      mockFaucet.mockRejectedValueOnce(new Error('rate limited'));
      const read = holdNextMarkerRead();
      fireEvent.click(
        within(screen.getAllByTestId('prompt-card')[0]!).getByRole('button', { name: 'faucetPromptTitle' })
      );
      await act(async () => {});
      expect(read.requested).toBe(true);

      const { sent, write } = anotherSurfaceSends();
      await act(async () => {});
      await act(async () => {
        read.release();
        await write;
      });

      expectClearedBefore(sent);
    });

    it("keeps it when an unsent request's wait ends", async () => {
      jest.useFakeTimers();
      try {
        mockUseWalletPromptStorage.mockReturnValue(makePromptState());
        const age = 30_000;
        markerStore.set('accountA', { requestedAt: Date.now() - age, baselineNoteIds: [] });
        renderCard();
        await act(async () => {});
        expect(screen.getAllByTestId('prompt-card')[0]).toHaveAttribute('data-hero', 'faucetPromptFunding');

        const read = holdNextMarkerRead();
        await act(async () => {
          await jest.advanceTimersByTimeAsync(FAUCET_UNSUBMITTED_MARKER_MS - age + 5_000);
        });
        expect(read.requested).toBe(true);
        const { sent, write } = anotherSurfaceSends();
        await act(async () => {
          await jest.advanceTimersByTimeAsync(0);
        });
        await act(async () => {
          read.release();
          await write;
        });

        expectClearedBefore(sent);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  it('clears a funding marker whose request never went out and has nothing running (#922)', async () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());
    // The realm that owned the request died during the proof of work (an
    // extension popup closed), and its request timeout has long passed: the marker
    // was never flagged submitted, so nothing was minted and there is nothing to wait for.
    mockFetchFaucetFundingMarker.mockResolvedValue({ requestedAt: Date.now() - 70_000, baselineNoteIds: [] });

    render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    await act(async () => {});

    await waitFor(() => expect(mockSetFaucetFundingMarker).toHaveBeenCalledWith('accountA', null));
    const card = screen.getAllByTestId('prompt-card')[0]!;
    expect(card).not.toHaveAttribute('data-hero', 'faucetPromptFunding');
    expect(card).toHaveAttribute('data-actionable', 'true');
  });

  it('keeps a recent unflagged marker with no request here: another surface may still be sending it', async () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());
    // The popup and the side panel share storage but not their in-flight requests, so
    // a surface opened during another's proof of work finds no request of its own.
    markerStore.set('accountA', { requestedAt: Date.now() - 5_000, baselineNoteIds: [] });

    render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );

    await waitFor(() =>
      expect(screen.getAllByTestId('prompt-card')[0]!).toHaveAttribute('data-hero', 'faucetPromptFunding')
    );
    expect(screen.getAllByTestId('prompt-card')[0]!).toHaveAttribute('data-actionable', 'false');
    expect(mockSetFaucetFundingMarker).not.toHaveBeenCalledWith('accountA', null);
  });

  it('ends a wait for a request never flagged submitted once its request timeout has passed', async () => {
    jest.useFakeTimers();
    try {
      mockUseWalletPromptStorage.mockReturnValue(makePromptState());
      markerStore.set('accountA', { requestedAt: Date.now() - 5_000, baselineNoteIds: [] });
      render(
        <HomePrompts
          account={account}
          balances={zeroBalance}
          balancesLoading={false}
          claimableNotes={[]}
          fundingNotes={[]}
          tokenPrices={{}}
        />
      );
      await act(async () => {});
      expect(screen.getAllByTestId('prompt-card')[0]!).toHaveAttribute('data-hero', 'faucetPromptFunding');

      // Still unflagged when the owning request must have timed out: it never went out.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(61_000);
      });

      const card = screen.getAllByTestId('prompt-card')[0]!;
      expect(card).not.toHaveAttribute('data-hero', 'faucetPromptFunding');
      expect(card).toHaveAttribute('data-actionable', 'true');
      expect(markerStore.has('accountA')).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps waiting past the request timeout when another surface flagged the request as sent', async () => {
    jest.useFakeTimers();
    try {
      mockUseWalletPromptStorage.mockReturnValue(makePromptState());
      const requestedAt = Date.now() - 5_000;
      markerStore.set('accountA', { requestedAt, baselineNoteIds: [] });
      render(
        <HomePrompts
          account={account}
          balances={zeroBalance}
          balancesLoading={false}
          claimableNotes={[]}
          fundingNotes={[]}
          tokenPrices={{}}
        />
      );
      await act(async () => {});
      // The other surface's proof of work finishes and its token request goes out.
      markerStore.set('accountA', { requestedAt, baselineNoteIds: [], submitted: true });

      await act(async () => {
        await jest.advanceTimersByTimeAsync(61_000);
      });

      expect(screen.getAllByTestId('prompt-card')[0]!).toHaveAttribute('data-hero', 'faucetPromptFunding');
      expect(markerStore.get('accountA')).toEqual({ requestedAt, baselineNoteIds: [], submitted: true });

      // Promoted, the wait runs to the arrival backstop and then ends: it is not left hanging.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(2 * 60_000);
      });
      expect(screen.getAllByTestId('prompt-card')[0]!).not.toHaveAttribute('data-hero', 'faucetPromptFunding');
      expect(markerStore.has('accountA')).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ['was accepted', () => mockFaucet.mockResolvedValueOnce(undefined)],
    [
      'went unanswered',
      () => mockFaucet.mockRejectedValueOnce(new FaucetOutcomeUnknownError('Faucet token request got no response'))
    ]
  ])('keeps waiting for the mint after its own request %s, past the request timeout', async (_outcome, settle) => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      mockUseWalletPromptStorage.mockReturnValue(makePromptState());
      settle();
      render(
        <HomePrompts
          account={account}
          balances={zeroBalance}
          balancesLoading={false}
          claimableNotes={[]}
          fundingNotes={[]}
          tokenPrices={{}}
        />
      );
      await act(async () => {});
      fireEvent.click(
        within(screen.getAllByTestId('prompt-card')[0]!).getByRole('button', { name: 'faucetPromptTitle' })
      );
      await act(async () => {});
      expect(mockFaucet).toHaveBeenCalledTimes(1);

      await act(async () => {
        await jest.advanceTimersByTimeAsync(70_000);
      });

      // Either way it was sent: the wait runs to the arrival backstop, not the request timeout.
      expect(screen.getAllByTestId('prompt-card')[0]!).toHaveAttribute('data-hero', 'faucetPromptFunding');
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not extend another account's wait when an earlier request is accepted", async () => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      mockUseWalletPromptStorage.mockReturnValue(makePromptState());
      let acceptA!: () => void;
      mockFaucet.mockImplementationOnce(
        () =>
          new Promise<void>(resolve => {
            acceptA = resolve;
          })
      );
      // B has a recent marker a surface that is now gone never flagged.
      markerStore.set('accountB', { requestedAt: Date.now() - 5_000, baselineNoteIds: [] });
      const renderFor = (who: WalletAccount) => (
        <HomePrompts
          account={who}
          balances={zeroBalance}
          balancesLoading={false}
          claimableNotes={[]}
          fundingNotes={[]}
          tokenPrices={{}}
        />
      );
      const { rerender } = render(renderFor(account));
      await act(async () => {});
      fireEvent.click(
        within(screen.getAllByTestId('prompt-card')[0]!).getByRole('button', { name: 'faucetPromptTitle' })
      );
      await act(async () => {});
      rerender(renderFor(accountB));
      await act(async () => {});
      expect(screen.getAllByTestId('prompt-card')[0]!).toHaveAttribute('data-hero', 'faucetPromptFunding');

      // A's request is accepted while B's wait is on screen.
      await act(async () => {
        acceptA();
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(61_000);
      });

      // B's request never went out, so B's wait still ends with its request timeout.
      expect(screen.getAllByTestId('prompt-card')[0]!).not.toHaveAttribute('data-hero', 'faucetPromptFunding');
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ['succeeds', (settle: { resolve: () => void; reject: (error: Error) => void }) => settle.resolve()],
    [
      'ends with an unknown outcome',
      (settle: { resolve: () => void; reject: (error: Error) => void }) =>
        settle.reject(new FaucetOutcomeUnknownError('Faucet token request got no response'))
    ]
  ])('waits for the mint of a joined request that %s, from its own marker rather than storage', async (_how, end) => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());
    // Remounted mid-request, with nothing readable in storage: the first marker write
    // never landed, and every later read fails.
    const settle: { resolve: () => void; reject: (error: Error) => void } = {
      resolve: () => undefined,
      reject: () => undefined
    };
    mockGetInFlightFaucetRequest.mockReturnValue(
      new Promise<void>((resolve, reject) => {
        settle.resolve = () => resolve();
        settle.reject = error => reject(error);
      })
    );
    mockGetInFlightFaucetMarker.mockReturnValue({ requestedAt: Date.now() - 5_000, baselineNoteIds: [] });
    mockFetchFaucetFundingMarker.mockResolvedValueOnce(null).mockRejectedValue(new Error('storage unavailable'));

    render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    await act(async () => {});
    await act(async () => {
      end(settle);
    });

    const card = screen.getAllByTestId('prompt-card')[0]!;
    expect(card).toHaveAttribute('data-hero', 'faucetPromptFunding');
    expect(card).toHaveAttribute('data-actionable', 'false');
  });

  it.each([
    ['its own request is accepted', 'tap-accepted'],
    ['its own request ends with an unknown outcome', 'tap-unknown'],
    ['a request it joined is accepted', 'join-accepted'],
    ['a request it joined ends with an unknown outcome', 'join-unknown']
  ])('keeps the Funding wait when %s after the app was away for minutes', async (_when, mode) => {
    const joined = mode.startsWith('join');
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      mockUseWalletPromptStorage.mockReturnValue(makePromptState());
      const settle: { resolve: () => void; reject: (error: Error) => void } = {
        resolve: () => undefined,
        reject: () => undefined
      };
      const pending = new Promise<void>((resolve, reject) => {
        settle.resolve = () => resolve();
        settle.reject = error => reject(error);
      });
      if (joined) {
        const requestedAt = Date.now() - 5_000;
        markerStore.set('accountA', { requestedAt, baselineNoteIds: [], submitted: true });
        mockGetInFlightFaucetRequest.mockReturnValue(pending);
        mockGetInFlightFaucetMarker.mockReturnValue({ requestedAt, baselineNoteIds: [] });
      } else {
        mockFaucet.mockReturnValueOnce(pending);
      }
      render(
        <HomePrompts
          account={account}
          balances={zeroBalance}
          balancesLoading={false}
          claimableNotes={[]}
          fundingNotes={[]}
          tokenPrices={{}}
        />
      );
      await act(async () => {});
      if (!joined) {
        fireEvent.click(
          within(screen.getAllByTestId('prompt-card')[0]!).getByRole('button', { name: 'faucetPromptTitle' })
        );
        await act(async () => {});
      }

      // Backgrounded while the request was out: the wall clock moved on, the timers did not.
      jest.setSystemTime(Date.now() + 4 * 60_000);
      await act(async () => {
        // As in production, a settled request is no longer reported as running.
        if (joined) mockGetInFlightFaucetRequest.mockReturnValue(null);
        if (mode.endsWith('unknown'))
          settle.reject(new FaucetOutcomeUnknownError('Faucet token request got no response'));
        else settle.resolve();
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(0);
      });

      // The mint may only now be landing: the wait runs from when this surface saw it go out.
      const card = screen.getAllByTestId('prompt-card')[0]!;
      expect(card).toHaveAttribute('data-hero', 'faucetPromptFunding');
      expect(card).toHaveAttribute('data-actionable', 'false');
      expect(mockSetFaucetFundingMarker).not.toHaveBeenCalledWith('accountA', null);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the marker and the wait of a sent request still running here, however long ago it was asked for', async () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());
    // This realm's timers were held for minutes mid-request (a backgrounded app).
    const marker = { requestedAt: Date.now() - 4 * 60_000, baselineNoteIds: [], submitted: true as const };
    markerStore.set('accountA', marker);
    mockGetInFlightFaucetRequest.mockReturnValue(new Promise<void>(() => {}));
    mockGetInFlightFaucetMarker.mockReturnValue(marker);

    render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    await act(async () => {});

    expect(screen.getAllByTestId('prompt-card')[0]).toHaveAttribute('data-hero', 'faucetPromptFunding');
    expect(markerStore.get('accountA')).toEqual(marker);
    expect(mockSetFaucetFundingMarker).not.toHaveBeenCalledWith('accountA', null);
  });

  it('keeps waiting past the window of a sent request that still runs here, since it has not settled', async () => {
    jest.useFakeTimers();
    try {
      mockUseWalletPromptStorage.mockReturnValue(makePromptState());
      const marker = { requestedAt: Date.now() - 170_000, baselineNoteIds: [], submitted: true as const };
      markerStore.set('accountA', marker);
      mockGetInFlightFaucetRequest.mockReturnValue(new Promise<void>(() => {}));
      mockGetInFlightFaucetMarker.mockReturnValue(marker);

      render(
        <HomePrompts
          account={account}
          balances={zeroBalance}
          balancesLoading={false}
          claimableNotes={[]}
          fundingNotes={[]}
          tokenPrices={{}}
        />
      );
      await act(async () => {});
      await act(async () => {
        await jest.advanceTimersByTimeAsync(15_000);
      });

      expect(screen.getAllByTestId('prompt-card')[0]).toHaveAttribute('data-hero', 'faucetPromptFunding');
      expect(markerStore.get('accountA')).toEqual(marker);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ['once 3 minutes from its recorded settle pass', 0],
    ['on time after the clock steps back past its recorded settle', 60 * 60_000]
  ])('ends a Funding wait %s', async (_when, clockStepBackMs) => {
    jest.useFakeTimers();
    try {
      mockUseWalletPromptStorage.mockReturnValue(makePromptState());
      render(
        <HomePrompts
          account={account}
          balances={zeroBalance}
          balancesLoading={false}
          claimableNotes={[]}
          fundingNotes={[]}
          tokenPrices={{}}
        />
      );
      await act(async () => {});
      fireEvent.click(
        within(screen.getAllByTestId('prompt-card')[0]!).getByRole('button', { name: 'faucetPromptTitle' })
      );
      await act(async () => {});
      // The request settled now, and this realm recorded it.
      const settledAt = Date.now();
      mockGetFaucetRequestSettledAt.mockImplementation(() => settledAt);
      expect(screen.getAllByTestId('prompt-card')[0]).toHaveAttribute('data-hero', 'faucetPromptFunding');

      if (clockStepBackMs) jest.setSystemTime(Date.now() - clockStepBackMs);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(3 * 60_000 + 1_000);
      });

      expect(screen.getAllByTestId('prompt-card')[0]).not.toHaveAttribute('data-hero', 'faucetPromptFunding');
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the wait when its request settles just before an overdue backstop runs', async () => {
    jest.useFakeTimers();
    try {
      mockUseWalletPromptStorage.mockReturnValue(makePromptState());
      const marker = {
        requestedAt: Date.now() - 10_000,
        baselineNoteIds: [],
        submitted: true as const,
        submittedAt: Date.now() - 5_000
      };
      markerStore.set('accountA', marker);
      mockGetInFlightFaucetRequest.mockReturnValue(new Promise<void>(() => {}));
      mockGetInFlightFaucetMarker.mockReturnValue(marker);

      render(
        <HomePrompts
          account={account}
          balances={zeroBalance}
          balancesLoading={false}
          claimableNotes={[]}
          fundingNotes={[]}
          tokenPrices={{}}
        />
      );
      await act(async () => {});

      // Frozen for minutes: on resume the request settles (recorded, and gone from the
      // in-flight map) and the overdue backstop runs before React renders the re-anchor.
      act(() => {
        mockGetInFlightFaucetRequest.mockReturnValue(null);
        mockGetFaucetRequestSettledAt.mockImplementation(() => Date.now());
        jest.advanceTimersByTime(3 * 60_000);
      });
      await act(async () => {});

      expect(screen.getAllByTestId('prompt-card')[0]).toHaveAttribute('data-hero', 'faucetPromptFunding');
      expect(markerStore.get('accountA')).toEqual(marker);
      expect(mockSetFaucetFundingMarker).not.toHaveBeenCalledWith('accountA', null);
    } finally {
      jest.useRealTimers();
    }
  });

  it('waits out the arrival window from when a request went out, for a request sent late', async () => {
    jest.useFakeTimers();
    try {
      mockUseWalletPromptStorage.mockReturnValue(makePromptState());
      // Asked for 5 minutes ago, sent 30s ago by a realm that was held back, then closed.
      markerStore.set('accountA', {
        requestedAt: Date.now() - 5 * 60_000,
        baselineNoteIds: [],
        submitted: true,
        submittedAt: Date.now() - 30_000
      });

      render(
        <HomePrompts
          account={account}
          balances={zeroBalance}
          balancesLoading={false}
          claimableNotes={[]}
          fundingNotes={[]}
          tokenPrices={{}}
        />
      );
      await act(async () => {});
      expect(screen.getAllByTestId('prompt-card')[0]).toHaveAttribute('data-hero', 'faucetPromptFunding');
      expect(screen.getAllByTestId('prompt-card')[0]).toHaveAttribute('data-actionable', 'false');

      await act(async () => {
        await jest.advanceTimersByTimeAsync(2 * 60_000);
      });
      expect(screen.getAllByTestId('prompt-card')[0]).toHaveAttribute('data-hero', 'faucetPromptFunding');

      await act(async () => {
        await jest.advanceTimersByTimeAsync(31_000);
      });
      expect(screen.getAllByTestId('prompt-card')[0]).not.toHaveAttribute('data-hero', 'faucetPromptFunding');
    } finally {
      jest.useRealTimers();
    }
  });

  it('runs a promoted wait from when its request went out', async () => {
    jest.useFakeTimers();
    try {
      mockUseWalletPromptStorage.mockReturnValue(makePromptState());
      const requestedAt = Date.now() - 30_000;
      markerStore.set('accountA', { requestedAt, baselineNoteIds: [] });

      render(
        <HomePrompts
          account={account}
          balances={zeroBalance}
          balancesLoading={false}
          claimableNotes={[]}
          fundingNotes={[]}
          tokenPrices={{}}
        />
      );
      await act(async () => {});
      // The surface that owns the request sends it late, 20s from now.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(20_000);
      });
      markerStore.set('accountA', { requestedAt, baselineNoteIds: [], submitted: true, submittedAt: Date.now() });

      // Past this wait's unsent deadline it is promoted...
      await act(async () => {
        await jest.advanceTimersByTimeAsync(20_000);
      });
      // ...then held for 3 minutes from the send, well past 3 minutes from the request.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(2 * 60_000 + 30_000);
      });
      expect(screen.getAllByTestId('prompt-card')[0]).toHaveAttribute('data-hero', 'faucetPromptFunding');

      await act(async () => {
        await jest.advanceTimersByTimeAsync(15_000);
      });
      expect(screen.getAllByTestId('prompt-card')[0]).not.toHaveAttribute('data-hero', 'faucetPromptFunding');
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not clear another surface's newer marker when its own wait times out", async () => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      mockUseWalletPromptStorage.mockReturnValue(makePromptState());
      render(
        <HomePrompts
          account={account}
          balances={zeroBalance}
          balancesLoading={false}
          claimableNotes={[]}
          fundingNotes={[]}
          tokenPrices={{}}
        />
      );
      await act(async () => {});
      fireEvent.click(
        within(screen.getAllByTestId('prompt-card')[0]!).getByRole('button', { name: 'faucetPromptTitle' })
      );
      await act(async () => {});

      // Shortly before this surface's wait ends, another surface (whose own wait ended
      // earlier) retries and sends a new request.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(3 * 60_000 - 10_000);
      });
      const newer = { requestedAt: Date.now(), baselineNoteIds: [], submitted: true };
      markerStore.set('accountA', newer);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(15_000);
      });

      // This surface's wait is over, but the newer request's marker is not its to clear:
      // the card waits for that request now...
      expect(markerStore.get('accountA')).toEqual(newer);
      expect(screen.getAllByTestId('prompt-card')[0]).toHaveAttribute('data-hero', 'faucetPromptFunding');

      // ...and gives Fund back once that request's own arrival window has passed.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(3 * 60_000);
      });
      expect(screen.getAllByTestId('prompt-card')[0]).not.toHaveAttribute('data-hero', 'faucetPromptFunding');
    } finally {
      jest.useRealTimers();
    }
  });

  it('resumes a wait from when this realm saw its request settle, not from the request time', async () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());
    // Asked for four minutes ago, but this realm saw it go out only just now: the app was
    // away in between. A remount must not end a wait whose mint may only now be landing.
    const requestedAt = Date.now() - 4 * 60_000;
    markerStore.set('accountA', { requestedAt, baselineNoteIds: [], submitted: true });
    mockGetFaucetRequestSettledAt.mockImplementation((address: string, at: number) =>
      address === 'accountA' && at === requestedAt ? Date.now() - 5_000 : null
    );

    render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    await act(async () => {});

    expect(screen.getAllByTestId('prompt-card')[0]!).toHaveAttribute('data-hero', 'faucetPromptFunding');
    expect(markerStore.has('accountA')).toBe(true);
  });

  it('keeps an unflagged marker while its request is still running in this realm (#922)', async () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());
    // Old enough to read as abandoned, but the request that wrote it is still running
    // here - its timers were held back (a backgrounded app), not its realm gone.
    mockFetchFaucetFundingMarker.mockResolvedValue({ requestedAt: Date.now() - 70_000, baselineNoteIds: [] });
    mockGetInFlightFaucetRequest.mockReturnValue(new Promise<void>(() => {}));

    render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    await act(async () => {});

    await waitFor(() =>
      expect(screen.getAllByTestId('prompt-card')[0]!).toHaveAttribute('data-hero', 'faucetPromptFunding')
    );
    expect(mockSetFaucetFundingMarker).not.toHaveBeenCalledWith('accountA', null);
  });

  it('keeps waiting when a request a remounted card joined ends with an unknown outcome (#919)', async () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());
    // The card was remounted while the token request was out: it observes the
    // outcome through the in-flight join, not through its own tap.
    mockFetchFaucetFundingMarker.mockResolvedValue({
      requestedAt: Date.now() - 5_000,
      baselineNoteIds: [],
      submitted: true
    });
    let rejectInFlight!: (error: Error) => void;
    mockGetInFlightFaucetRequest.mockReturnValue(
      new Promise<void>((_resolve, reject) => {
        rejectInFlight = reject;
      })
    );

    render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    const card = screen.getAllByTestId('prompt-card')[0]!;
    await waitFor(() => expect(card).toHaveAttribute('data-hero', 'faucetPromptFunding'));

    await act(async () => {
      rejectInFlight(new FaucetOutcomeUnknownError('Faucet request timed out after the token request was sent'));
    });

    // The faucet may have minted: no failure, and no retry.
    expect(card).toHaveAttribute('data-hero', 'faucetPromptFunding');
    expect(card).not.toHaveAttribute('data-status', 'failure');
    expect(card).toHaveAttribute('data-actionable', 'false');
  });

  it('does not count a non-native note as the mint arriving', async () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());

    const { rerender } = render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    const faucetCard = screen.getAllByTestId('prompt-card')[0]!;
    // Let this account's funding marker read settle: the card is not offered
    // as actionable until it has.
    await act(async () => {});
    fireEvent.click(within(faucetCard).getByRole('button', { name: 'faucetPromptTitle' }));
    await waitFor(() => expect(faucetCard).toHaveAttribute('data-hero', 'faucetPromptFunding'));

    // A new note from a DIFFERENT faucet (e.g. an unrelated inbound transfer,
    // or a pre-existing note whose metadata only just resolved) must NOT play
    // the success beat - the request only ever mints native MIDEN.
    rerender(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={nonNativeNotes}
        fundingNotes={nonNativeNotes}
        tokenPrices={tokenPrices}
      />
    );
    expect(faucetCard).toHaveAttribute('data-hero', 'faucetPromptFunding');
    expect(mockSetFaucetStatus).not.toHaveBeenCalledWith('accountA', WalletPromptStatus.Completed);

    // The native mint landing still completes the lifecycle.
    rerender(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[...nonNativeNotes, ...pendingNotes]}
        fundingNotes={[...nonNativeNotes, ...pendingNotes]}
        tokenPrices={tokenPrices}
      />
    );
    await waitFor(() => expect(faucetCard).toHaveAttribute('data-hero', 'faucetPromptFunded'));
    await waitFor(() => expect(mockSetFaucetStatus).toHaveBeenCalledWith('accountA', WalletPromptStatus.Completed), {
      timeout: 3500
    });
  });

  it('stops suppressing pending notes once the faucet card itself is gone', async () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());
    // A remount re-attaches to a request still running at module scope, which
    // paints the loading indicator WITHOUT arming a wait. On an account that
    // already has a balance the faucet card is not shown at all, so a hero flag
    // that keys off the indicator alone suppresses pending-notes behind a card
    // that is not on stage - an empty carousel for up to the 60s timeout.
    mockGetInFlightFaucetRequest.mockReturnValue(new Promise<void>(() => {}));

    render(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={pendingNotes}
        fundingNotes={pendingNotes}
        tokenPrices={tokenPrices}
      />
    );

    const cardByTitle = (title: string) =>
      screen.queryAllByTestId('prompt-card').find(card => card.getAttribute('data-title') === title);

    // The faucet card is genuinely gone…
    await waitFor(() => expect(cardByTitle('faucetPromptTitle')).toBeUndefined());
    // …so the pending-notes card must be reachable rather than held back by it.
    expect(cardByTitle('pendingNotesPromptTitle')).toBeDefined();
  });

  it('drops the wait when the request fails after a switch away mid-request', async () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());
    // A's request is still out when the user switches to B, and it fails with B
    // on screen. Its marker is already persisted and flagged, so if the failure
    // left it behind, switching back to A would resume a Funding hero with no
    // request behind it until the 3-minute backstop.
    let rejectFaucet!: (error: Error) => void;
    mockFaucet.mockImplementation(
      (address: string, marker: object) =>
        new Promise<void>((_resolve, reject) => {
          // As the real request does before it sends anything that can mint.
          markerStore.set(address, { ...marker, submitted: true });
          rejectFaucet = reject;
        })
    );

    const { rerender } = render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    // Let this account's funding marker read settle: the card is not offered
    // as actionable until it has.
    await act(async () => {});
    fireEvent.click(
      within(screen.getAllByTestId('prompt-card')[0]!).getByRole('button', { name: 'faucetPromptTitle' })
    );
    await waitFor(() => expect(mockFaucet).toHaveBeenCalledWith('accountA', expect.anything()));

    rerender(
      <HomePrompts
        account={accountB}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    await act(async () => {
      rejectFaucet(new Error('rate limited'));
    });

    // The failed request clears A's persisted marker even though B was on screen.
    await waitFor(() => expect(mockSetFaucetFundingMarker).toHaveBeenCalledWith('accountA', null));

    // Switching back must show an actionable card: the request is over and the
    // marker was cleared. Re-arming the hero here strands the user in a Funding
    // state with nothing behind it until the 3-minute backstop.
    rerender(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    await act(async () => {});
    expect(screen.getAllByTestId('prompt-card')[0]!).not.toHaveAttribute('data-hero', 'faucetPromptFunding');
  });

  it('joins an in-flight request from a remount instead of starting a second mint', async () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());
    // Simulate the module-scoped request a previous mount left running.
    let rejectInFlight!: (error: Error) => void;
    const inFlight = new Promise<void>((_resolve, reject) => {
      rejectInFlight = reject;
    });
    mockGetInFlightFaucetRequest.mockReturnValue(inFlight);

    render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    const faucetCard = screen.getAllByTestId('prompt-card')[0]!;
    // The remounted card re-attaches: loading state, and no second faucet call
    // even though nothing was tapped on THIS mount.
    await waitFor(() => expect(faucetCard).toHaveAttribute('data-hero', 'faucetPromptFunding'));
    expect(mockFaucet).not.toHaveBeenCalled();

    // The in-flight request failing paints THIS card with the reason.
    rejectInFlight(new Error('faucet exploded'));
    await waitFor(() => expect(faucetCard).toHaveAttribute('data-status', 'failure'));
    expect(faucetCard).toHaveTextContent('faucet exploded');
  });

  it('funding one account does not block funding another', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());
    // Account A has a request in flight at module scope; account B does not.
    mockGetInFlightFaucetRequest.mockImplementation((address: string) =>
      address === 'accountA' ? new Promise<void>(() => undefined) : null
    );

    const { rerender } = render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    // Tapping A's card joins the running request rather than re-minting.
    const cardA = screen.getAllByTestId('prompt-card')[0]!;
    await waitFor(() => expect(cardA).toHaveAttribute('data-hero', 'faucetPromptFunding'));
    expect(mockFaucet).not.toHaveBeenCalled();

    rerender(
      <HomePrompts
        account={accountB}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    const cardB = screen.getAllByTestId('prompt-card')[0]!;
    // Let this account's funding marker read settle: the card is not offered
    // as actionable until it has.
    await act(async () => {});
    fireEvent.click(within(cardB).getByRole('button', { name: 'faucetPromptTitle' }));

    await waitFor(() => expect(mockFaucet).toHaveBeenCalledWith('accountB', expect.anything()));
  });

  it('dismisses the faucet prompt without calling the faucet', () => {
    const dismissPrompt = jest.fn();
    mockUseWalletPromptStorage.mockReturnValue(makePromptState({ dismissPrompt }));

    render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'dismiss-faucetPromptTitle' }));

    expect(mockSetFaucetStatus).toHaveBeenCalledWith('accountA', WalletPromptStatus.Dismissed);
    expect(mockFaucet).not.toHaveBeenCalled();
  });

  it('shows pending notes first with their USD value and navigates on card tap', () => {
    const promptState = makePromptState();
    mockUseWalletPromptStorage.mockReturnValue(promptState);

    render(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={pendingNotes}
        fundingNotes={pendingNotes}
        tokenPrices={tokenPrices}
      />
    );

    expect(screen.getAllByTestId('prompt-card').map(card => card.dataset.title)).toEqual([
      'pendingNotesPromptTitle',
      'verifySeedPhrasePromptTitle'
    ]);
    // The money is its own value on the body line, not a number buried in a translated sentence.
    expect(screen.getByTestId('prompt-card-value')).toHaveTextContent('$4.50');
    expect(screen.queryByRole('button', { name: 'pendingNotesPromptAction' })).not.toBeInTheDocument();
    // Nothing waiting to be accepted can be swept away.
    expect(screen.queryByRole('button', { name: 'dismiss-pendingNotesPromptTitle' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'pendingNotesPromptTitle' }));
    expect(jest.requireMock('lib/woozie').navigate).toHaveBeenCalledWith('/history?filter=pending');
  });

  it('leaves a declined transfer out of the count and out of the total, until it is restored', () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());
    // `note-1` was declined on the Activity tab. It is still claimable — declining only hides it
    // — so the raw list still carries it, and the banner used to count it and add its value.
    mockHiddenNotes.ids = new Set(['note-1']);

    const { rerender } = render(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={pendingNotes}
        fundingNotes={pendingNotes}
        tokenPrices={tokenPrices}
      />
    );

    expect(screen.getByTestId('prompt-card-value')).not.toHaveTextContent('$4.50');
    expect(screen.getByText('pendingNotesPromptBody:1')).toBeInTheDocument();

    // Restore puts it back, and the banner agrees again.
    mockHiddenNotes.ids = new Set();
    rerender(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={pendingNotes}
        fundingNotes={pendingNotes}
        tokenPrices={tokenPrices}
      />
    );
    expect(screen.getByTestId('prompt-card-value')).toHaveTextContent('$4.50');
    expect(screen.getByText('pendingNotesPromptBody:2')).toBeInTheDocument();
  });

  it('shows nothing at all when every pending transfer has been declined', () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());
    mockHiddenNotes.ids = new Set(['note-1', 'note-2']);

    render(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={pendingNotes}
        fundingNotes={pendingNotes}
        tokenPrices={tokenPrices}
      />
    );

    expect(screen.queryByText('pendingNotesPromptTitle')).not.toBeInTheDocument();
  });

  it('ignores a dismissal an older build stored: the card cannot be dismissed any more', () => {
    const setPromptStatus = jest.fn();
    mockUseWalletPromptStorage.mockReturnValue(
      makePromptState({
        setPromptStatus,
        storage: {
          version: 1,
          prompts: { [WalletPromptType.PendingNotes]: WalletPromptStatus.Dismissed },
          pendingNotesDismissedIds: ['note-1', 'note-2']
        },
        isPromptPending: () => false
      })
    );

    render(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={[pendingNotes[0]!, { ...pendingNotes[1]!, id: 'note-3' }]}
        fundingNotes={[pendingNotes[0]!, { ...pendingNotes[1]!, id: 'note-3' }]}
        tokenPrices={tokenPrices}
      />
    );

    // A wallet that dismissed the card once must not go silent about every later transfer.
    expect(screen.getByText('pendingNotesPromptTitle')).toBeInTheDocument();
    expect(setPromptStatus).not.toHaveBeenCalled();
  });

  it('resurfaces for a later batch disjoint from the dismissed note ids', () => {
    mockUseWalletPromptStorage.mockReturnValue(
      makePromptState({
        storage: {
          version: 1,
          prompts: { [WalletPromptType.PendingNotes]: WalletPromptStatus.Dismissed },
          pendingNotesDismissedIds: ['old-note']
        },
        isPromptPending: () => false
      })
    );

    render(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={pendingNotes}
        fundingNotes={pendingNotes}
        tokenPrices={tokenPrices}
      />
    );

    expect(screen.getByText('pendingNotesPromptTitle')).toBeInTheDocument();
  });

  it('shows no pending-note prompt and writes no status when no notes remain', () => {
    const setPromptStatus = jest.fn();
    mockUseWalletPromptStorage.mockReturnValue(
      makePromptState({
        setPromptStatus,
        storage: {
          version: 1,
          prompts: { [WalletPromptType.PendingNotes]: WalletPromptStatus.Dismissed },
          pendingNotesDismissedIds: ['note-1']
        },
        isPromptPending: () => false
      })
    );

    render(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );

    expect(screen.queryByText('pendingNotesPromptTitle')).not.toBeInTheDocument();
    expect(setPromptStatus).not.toHaveBeenCalled();
  });

  it('completes the bridge prompt when no active bridge remains at fetch time', async () => {
    const completePrompt = jest.fn();
    mockFetchActiveBridgePrompts.mockResolvedValue([]);
    mockUseWalletPromptStorage.mockReturnValue(
      makePromptState({
        completePrompt,
        storage: {
          version: 1,
          prompts: { [WalletPromptType.Bridge]: WalletPromptStatus.Pending },
          pendingNotesDismissedIds: []
        },
        isPromptPending: (type: WalletPromptType) => type === WalletPromptType.Bridge
      })
    );

    render(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );

    await waitFor(() => expect(completePrompt).toHaveBeenCalledWith(WalletPromptType.Bridge));
    expect(screen.queryByText('bridgePromptTitle')).not.toBeInTheDocument();
  });

  it('completes the bridge prompt once a later read finds the last bridge settled', async () => {
    jest.useFakeTimers();
    const completePrompt = jest.fn();
    const bridgeTransaction = { id: 'bridge-1', type: 'bridged-send' };
    mockFetchActiveBridgePrompts.mockResolvedValueOnce([bridgeTransaction]).mockResolvedValueOnce([]);
    mockUseWalletPromptStorage.mockReturnValue(
      makePromptState({
        completePrompt,
        storage: {
          version: 1,
          prompts: { [WalletPromptType.Bridge]: WalletPromptStatus.Pending },
          pendingNotesDismissedIds: []
        },
        isPromptPending: (type: WalletPromptType) => type === WalletPromptType.Bridge
      })
    );

    render(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );

    await act(async () => {});
    expect(await screen.findByText('bridgePromptTitle')).toBeInTheDocument();
    expect(completePrompt).not.toHaveBeenCalled();

    // The app-root watcher settles the row; the next read sees it gone.
    await act(async () => {
      jest.advanceTimersByTime(8_000);
    });
    await act(async () => {});
    expect(mockFetchActiveBridgePrompts).toHaveBeenCalledTimes(2);
    expect(completePrompt).toHaveBeenCalledWith(WalletPromptType.Bridge);
    jest.useRealTimers();
  });

  it('survives a bridge poll failure without completing the prompt', async () => {
    const completePrompt = jest.fn();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetchActiveBridgePrompts.mockRejectedValue(new Error('indexer down'));
    mockUseWalletPromptStorage.mockReturnValue(
      makePromptState({
        completePrompt,
        storage: {
          version: 1,
          prompts: { [WalletPromptType.Bridge]: WalletPromptStatus.Pending },
          pendingNotesDismissedIds: []
        },
        isPromptPending: (type: WalletPromptType) => type === WalletPromptType.Bridge
      })
    );

    render(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );

    await waitFor(() =>
      expect(warnSpy).toHaveBeenCalledWith('[wallet-prompts] bridge poll failed:', expect.any(Error))
    );
    expect(completePrompt).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('shows the stored hot-key hardware error and copies it on the report action', async () => {
    mockFetchHotKeyHardwareError.mockResolvedValue({ message: 'TEE unavailable (code 7)' });
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mockUseWalletPromptStorage.mockReturnValue(
      makePromptState({
        storage: {
          version: 1,
          prompts: { [WalletPromptType.HotKeyHardwareUnavailable]: WalletPromptStatus.Pending },
          pendingNotesDismissedIds: []
        },
        isPromptPending: (type: WalletPromptType) => type === WalletPromptType.HotKeyHardwareUnavailable
      })
    );

    render(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );

    await waitFor(() => expect(mockFetchHotKeyHardwareError).toHaveBeenCalled());
    // Flush the microtask that lands the fetched error in component state.
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'hotKeyHardwareErrorPromptAction' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('TEE unavailable (code 7)'));
    await waitFor(() => {
      expect(screen.getByTestId('prompt-card')).toHaveAttribute('data-status', 'success');
    });
  });

  it('arms no timer when it unmounts while the clipboard write is still pending', async () => {
    jest.useFakeTimers();
    mockFetchHotKeyHardwareError.mockResolvedValue({ message: 'TEE unavailable (code 7)' });
    let resolveWrite: () => void = () => undefined;
    const writeText = jest.fn(
      () =>
        new Promise<void>(resolve => {
          resolveWrite = resolve;
        })
    );
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mockUseWalletPromptStorage.mockReturnValue(
      makePromptState({
        storage: {
          version: 1,
          prompts: { [WalletPromptType.HotKeyHardwareUnavailable]: WalletPromptStatus.Pending },
          pendingNotesDismissedIds: []
        },
        isPromptPending: (type: WalletPromptType) => type === WalletPromptType.HotKeyHardwareUnavailable
      })
    );

    const { unmount } = render(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );

    await waitFor(() => expect(mockFetchHotKeyHardwareError).toHaveBeenCalled());
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'hotKeyHardwareErrorPromptAction' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());

    unmount();
    // The feedback timer is armed only AFTER the awaited write, so at unmount there is nothing for
    // the cleanup to clear. Without a liveness check the continuation arms one anyway.
    await act(async () => {
      resolveWrite();
    });
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });

  it('marks the copy action failed when the clipboard rejects', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const writeText = jest.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mockUseWalletPromptStorage.mockReturnValue(
      makePromptState({
        storage: {
          version: 1,
          prompts: { [WalletPromptType.HotKeyHardwareUnavailable]: WalletPromptStatus.Pending },
          pendingNotesDismissedIds: []
        },
        isPromptPending: (type: WalletPromptType) => type === WalletPromptType.HotKeyHardwareUnavailable
      })
    );

    render(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'hotKeyHardwareErrorPromptAction' }));
    await waitFor(() => {
      expect(screen.getByTestId('prompt-card')).toHaveAttribute('data-status', 'failure');
    });
    errorSpy.mockRestore();
  });

  // Where the Clipboard API is absent the DEREFERENCE throws, so before the write was owned by an
  // async function the `.catch` that sets this indicator was never attached to anything.
  it('marks the copy action failed where the Clipboard API is absent entirely', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const stub = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    delete (navigator as { clipboard?: unknown }).clipboard;
    mockUseWalletPromptStorage.mockReturnValue(
      makePromptState({
        storage: {
          version: 1,
          prompts: { [WalletPromptType.HotKeyHardwareUnavailable]: WalletPromptStatus.Pending },
          pendingNotesDismissedIds: []
        },
        isPromptPending: (type: WalletPromptType) => type === WalletPromptType.HotKeyHardwareUnavailable
      })
    );

    render(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'hotKeyHardwareErrorPromptAction' }));
    await waitFor(() => {
      expect(screen.getByTestId('prompt-card')).toHaveAttribute('data-status', 'failure');
    });
    errorSpy.mockRestore();
    if (stub) Object.defineProperty(navigator, 'clipboard', stub);
  });

  it('initiates a hot-key rotation and routes to the generating-transaction page from the rotation prompt', async () => {
    const completePrompt = jest.fn();
    mockInitiateReplaceHotKeyTransaction.mockResolvedValue('tx-rotate-1');
    mockUseWalletPromptStorage.mockReturnValue(
      makePromptState({
        completePrompt,
        storage: {
          version: 1,
          prompts: { [WalletPromptType.HotKeyRotationNeeded]: WalletPromptStatus.Pending },
          pendingNotesDismissedIds: []
        },
        isPromptPending: (type: WalletPromptType) => type === WalletPromptType.HotKeyRotationNeeded
      })
    );

    render(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'hotKeyRotationPromptAction' }));

    await waitFor(() =>
      expect(mockInitiateReplaceHotKeyTransaction).toHaveBeenCalledWith('accountA', true, { tag: 'zustand-provider' })
    );
    expect(completePrompt).toHaveBeenCalledWith(WalletPromptType.HotKeyRotationNeeded);
    expect(jest.requireMock('lib/woozie').navigate).toHaveBeenCalledWith('/generating-transaction/tx-rotate-1');
  });

  it('marks the rotation action failed when the initiate rejects, without completing the prompt', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const completePrompt = jest.fn();
    mockInitiateReplaceHotKeyTransaction.mockRejectedValue(new Error('not a guardian account'));
    mockUseWalletPromptStorage.mockReturnValue(
      makePromptState({
        completePrompt,
        storage: {
          version: 1,
          prompts: { [WalletPromptType.HotKeyRotationNeeded]: WalletPromptStatus.Pending },
          pendingNotesDismissedIds: []
        },
        isPromptPending: (type: WalletPromptType) => type === WalletPromptType.HotKeyRotationNeeded
      })
    );

    render(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={[]}
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'hotKeyRotationPromptAction' }));

    await waitFor(() => {
      expect(screen.getByTestId('prompt-card')).toHaveAttribute('data-status', 'failure');
    });
    expect(completePrompt).not.toHaveBeenCalled();
    expect(jest.requireMock('lib/woozie').navigate).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
