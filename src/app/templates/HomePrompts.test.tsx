import React from 'react';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import type { TokenBalanceData } from 'lib/miden/front';
import type { WalletAccount } from 'lib/shared/types';
import type { PendingNoteValue } from 'lib/wallet-prompts';
import { WalletPromptStatus, WalletPromptType } from 'lib/wallet-prompts';

import { HomePrompts } from './HomePrompts';

const mockFaucet = jest.fn();
const mockFetchActiveBridgePrompts = jest.fn();
const mockPollActiveBridgePrompts = jest.fn();
const mockUseWalletPromptStorage = jest.fn();
const mockFetchHotKeyHardwareError = jest.fn();
const mockFetchFaucetFundingMarker = jest.fn();
const mockSetFaucetFundingMarker = jest.fn();

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { amount?: string }) => (values?.amount === undefined ? key : `${key}:${values.amount}`)
  })
}));

jest.mock('components/ui', () => ({
  PromptCarousel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PromptCard: ({
    title,
    body,
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
    hero?: { icon: string; label: string; tone: string };
    onClick?: () => void;
    actionLabel?: string;
    onAction?: () => void;
    actionDisabled?: boolean;
    status?: string;
    onDismiss?: () => void;
  }) => (
    <section data-testid="prompt-card" data-title={title} data-status={status} data-hero={hero?.label}>
      <button type="button" onClick={onClick}>
        {title}
      </button>
      {body && <p>{body}</p>}
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

jest.mock('lib/wallet-prompts', () => {
  const actual = jest.requireActual('lib/wallet-prompts');
  return {
    ...actual,
    faucet: (address: string) => mockFaucet(address),
    fetchActiveBridgePrompts: (address: string) => mockFetchActiveBridgePrompts(address),
    fetchFaucetFundingMarker: (address: string) => mockFetchFaucetFundingMarker(address),
    setFaucetFundingMarker: (address: string, marker: unknown) => mockSetFaucetFundingMarker(address, marker),
    fetchHotKeyHardwareError: () => mockFetchHotKeyHardwareError(),
    pollActiveBridgePrompts: (transactions: unknown[]) => mockPollActiveBridgePrompts(transactions),
    useWalletPromptStorage: () => mockUseWalletPromptStorage()
  };
});

jest.mock('lib/woozie', () => ({ navigate: jest.fn() }));

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
const pendingNotes: PendingNoteValue[] = [
  { id: 'note-1', amount: '1250000', metadata: { decimals: 6, symbol: 'MIDEN' } },
  { id: 'note-2', amount: '2000000', metadata: { decimals: 6, symbol: 'USDC' } }
];
const tokenPrices = {
  MIDEN: { price: 2, change24h: 0, percentageChange24h: 0 },
  USDC: { price: 1, change24h: 0, percentageChange24h: 0 }
};

const makePromptState = (overrides: Record<string, unknown> = {}) => ({
  storage: { version: 1, prompts: {}, pendingNotesDismissedIds: [] },
  isLoaded: true,
  setPromptStatus: jest.fn(),
  dismissPrompt: jest.fn(),
  completePrompt: jest.fn(),
  isPromptPending: (type: WalletPromptType) => type === WalletPromptType.VerifySeedPhrase,
  ...overrides
});

describe('HomePrompts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFaucet.mockResolvedValue(undefined);
    mockFetchActiveBridgePrompts.mockResolvedValue([]);
    mockPollActiveBridgePrompts.mockResolvedValue(undefined);
    mockFetchHotKeyHardwareError.mockResolvedValue(null);
    mockFetchFaucetFundingMarker.mockResolvedValue(null);
    mockSetFaucetFundingMarker.mockResolvedValue(undefined);
  });

  it('polls and dismisses a pending bridge through the wallet prompt type', async () => {
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
        tokenPrices={{}}
      />
    );

    const bridgeCard = await screen.findByText('bridgePromptTitle');
    await waitFor(() => expect(mockPollActiveBridgePrompts).toHaveBeenCalledWith([bridgeTransaction]));
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
        tokenPrices={{}}
      />
    );

    expect(screen.getAllByTestId('prompt-card').map(card => card.dataset.title)).toEqual([
      'faucetPromptTitle',
      'verifySeedPhrasePromptTitle'
    ]);
    expect(promptState.setPromptStatus).toHaveBeenCalledWith(WalletPromptType.Faucet, WalletPromptStatus.Pending);
  });

  it('does not show the faucet while balances load or when the account has funds', () => {
    const completePrompt = jest.fn();
    mockUseWalletPromptStorage.mockReturnValue(
      makePromptState({
        completePrompt,
        storage: {
          version: 1,
          prompts: { [WalletPromptType.Faucet]: WalletPromptStatus.Pending },
          pendingNotesDismissedIds: []
        }
      })
    );

    const { rerender } = render(
      <HomePrompts account={account} balances={zeroBalance} balancesLoading claimableNotes={[]} tokenPrices={{}} />
    );
    expect(screen.queryByText('faucetPromptTitle')).not.toBeInTheDocument();

    rerender(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={[]}
        tokenPrices={{}}
      />
    );
    expect(screen.queryByText('faucetPromptTitle')).not.toBeInTheDocument();
    expect(completePrompt).toHaveBeenCalledWith(WalletPromptType.Faucet);
  });

  it('funds on card tap, holds the Funding hero, then plays Funded! and completes when notes arrive', async () => {
    const completePrompt = jest.fn();
    mockUseWalletPromptStorage.mockReturnValue(makePromptState({ completePrompt }));

    const { rerender } = render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        tokenPrices={{}}
      />
    );
    const faucetCard = screen.getAllByTestId('prompt-card')[0]!;
    fireEvent.click(within(faucetCard).getByRole('button', { name: 'faucetPromptTitle' }));

    await waitFor(() => expect(mockFaucet).toHaveBeenCalledWith('accountA'));
    expect(mockFaucet).toHaveBeenCalledTimes(1);
    // The faucet ack alone must not complete the prompt — the Funding hero
    // holds until the minted funds are actually visible.
    await waitFor(() => expect(faucetCard).toHaveAttribute('data-hero', 'faucetPromptFunding'));
    expect(faucetCard).toHaveAttribute('data-status', 'loading');
    expect(completePrompt).not.toHaveBeenCalled();

    // The minted note becomes claimable → Funded! beat, then completion.
    rerender(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={pendingNotes}
        tokenPrices={tokenPrices}
      />
    );
    await waitFor(() => expect(faucetCard).toHaveAttribute('data-hero', 'faucetPromptFunded'));
    expect(faucetCard).toHaveAttribute('data-status', 'success');
    expect(completePrompt).not.toHaveBeenCalled();
    // The pending-notes card must hold back while the success beat plays —
    // it sorts first in the carousel and would push the hero off-screen.
    expect(screen.queryByText('pendingNotesPromptTitle')).not.toBeInTheDocument();
    await waitFor(() => expect(completePrompt).toHaveBeenCalledWith(WalletPromptType.Faucet), { timeout: 3500 });
    // Beat over → the pending-notes card takes the stage.
    await waitFor(() => expect(screen.getByText('pendingNotesPromptTitle')).toBeInTheDocument());
  });

  it('plays the Funded! beat and completes when the balance arrives directly', async () => {
    const completePrompt = jest.fn();
    mockUseWalletPromptStorage.mockReturnValue(
      makePromptState({
        completePrompt,
        storage: {
          version: 1,
          prompts: { [WalletPromptType.Faucet]: WalletPromptStatus.Pending },
          pendingNotesDismissedIds: []
        }
      })
    );

    const { rerender } = render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        tokenPrices={{}}
      />
    );
    const faucetCard = screen.getAllByTestId('prompt-card')[0]!;
    fireEvent.click(within(faucetCard).getByRole('button', { name: 'faucetPromptTitle' }));
    await waitFor(() => expect(mockFaucet).toHaveBeenCalledWith('accountA'));
    expect(completePrompt).not.toHaveBeenCalled();

    rerender(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={[]}
        tokenPrices={{}}
      />
    );
    await waitFor(() => expect(faucetCard).toHaveAttribute('data-hero', 'faucetPromptFunded'));
    await waitFor(() => expect(completePrompt).toHaveBeenCalledWith(WalletPromptType.Faucet), { timeout: 3000 });
  });

  it('resumes the Funding hero from a persisted marker after a remount mid-wait', async () => {
    const completePrompt = jest.fn();
    mockFetchFaucetFundingMarker.mockResolvedValue({ requestedAt: Date.now() - 5_000, baselineNoteIds: [] });
    mockUseWalletPromptStorage.mockReturnValue(
      makePromptState({
        completePrompt,
        storage: {
          version: 1,
          prompts: { [WalletPromptType.Faucet]: WalletPromptStatus.Pending },
          pendingNotesDismissedIds: []
        }
      })
    );

    const { rerender } = render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
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
        tokenPrices={tokenPrices}
      />
    );
    await waitFor(() => expect(faucetCard).toHaveAttribute('data-hero', 'faucetPromptFunded'));
    expect(mockSetFaucetFundingMarker).toHaveBeenCalledWith('accountA', null);
    await waitFor(() => expect(completePrompt).toHaveBeenCalledWith(WalletPromptType.Faucet), { timeout: 3500 });
  });

  it('keeps one account Funding wait off another account and resumes it on switch-back', async () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());

    const { rerender } = render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        tokenPrices={{}}
      />
    );
    const faucetCard = screen.getAllByTestId('prompt-card')[0]!;
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
        ? Promise.resolve({ requestedAt: Date.now() - 5_000, baselineNoteIds: [] })
        : Promise.resolve(null)
    );
    rerender(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        tokenPrices={{}}
      />
    );
    await waitFor(() =>
      expect(screen.getAllByTestId('prompt-card')[0]!).toHaveAttribute('data-hero', 'faucetPromptFunding')
    );
    expect(mockFaucet).toHaveBeenCalledTimes(1);
  });

  it('does not treat a pre-existing claimable note as the faucet mint landing', async () => {
    const completePrompt = jest.fn();
    mockUseWalletPromptStorage.mockReturnValue(makePromptState({ completePrompt }));
    const preexistingNote = pendingNotes[0]!;

    const { rerender } = render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[preexistingNote]}
        tokenPrices={tokenPrices}
      />
    );
    const faucetCard = screen.getAllByTestId('prompt-card').find(card => card.dataset.title === 'faucetPromptTitle')!;
    fireEvent.click(within(faucetCard).getByRole('button', { name: 'faucetPromptTitle' }));

    // The note that already existed at request time must NOT flip the card
    // straight to success — the Funding hero holds.
    await waitFor(() => expect(faucetCard).toHaveAttribute('data-hero', 'faucetPromptFunding'));
    await act(async () => {});
    expect(faucetCard).toHaveAttribute('data-hero', 'faucetPromptFunding');
    expect(completePrompt).not.toHaveBeenCalled();

    // Only a NEW note (beyond the request-time baseline) lands the funds.
    rerender(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[preexistingNote, { ...pendingNotes[1]!, id: 'minted-note' }]}
        tokenPrices={tokenPrices}
      />
    );
    await waitFor(() => expect(faucetCard).toHaveAttribute('data-hero', 'faucetPromptFunded'));
  });

  it('ends a resumed wait three minutes after the original request, not after the remount', async () => {
    jest.useFakeTimers();
    try {
      // The marker is already 2:50 old at remount.
      mockFetchFaucetFundingMarker.mockResolvedValue({ requestedAt: Date.now() - 170_000, baselineNoteIds: [] });
      mockUseWalletPromptStorage.mockReturnValue(makePromptState());

      render(
        <HomePrompts
          account={account}
          balances={zeroBalance}
          balancesLoading={false}
          claimableNotes={[]}
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
        tokenPrices={{}}
      />
    );
    const faucetCard = screen.getAllByTestId('prompt-card')[0]!;
    const card = within(faucetCard).getByRole('button', { name: 'faucetPromptTitle' });

    fireEvent.click(card);
    await waitFor(() => expect(faucetCard).toHaveAttribute('data-status', 'failure'));
    fireEvent.click(card);

    await waitFor(() => expect(mockFaucet).toHaveBeenCalledTimes(2));
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
        tokenPrices={{}}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'dismiss-faucetPromptTitle' }));

    expect(dismissPrompt).toHaveBeenCalledWith(WalletPromptType.Faucet);
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
        tokenPrices={tokenPrices}
      />
    );

    expect(screen.getAllByTestId('prompt-card').map(card => card.dataset.title)).toEqual([
      'pendingNotesPromptTitle',
      'verifySeedPhrasePromptTitle'
    ]);
    expect(screen.getByText('pendingNotesPromptBody:$4.50')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'pendingNotesPromptAction' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'pendingNotesPromptTitle' }));
    expect(jest.requireMock('lib/woozie').navigate).toHaveBeenCalledWith('/pending-notes');
  });

  it('dismisses the current pending-note batch by note id', () => {
    const setPromptStatus = jest.fn();
    mockUseWalletPromptStorage.mockReturnValue(makePromptState({ setPromptStatus }));

    render(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={pendingNotes}
        tokenPrices={tokenPrices}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'dismiss-pendingNotesPromptTitle' }));

    expect(setPromptStatus).toHaveBeenCalledWith(WalletPromptType.PendingNotes, WalletPromptStatus.Dismissed, [
      'note-1',
      'note-2'
    ]);
  });

  it('keeps a dismissed batch hidden while one of its notes remains', () => {
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
        tokenPrices={tokenPrices}
      />
    );

    expect(screen.queryByText('pendingNotesPromptTitle')).not.toBeInTheDocument();
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
        tokenPrices={{}}
      />
    );

    await waitFor(() => expect(completePrompt).toHaveBeenCalledWith(WalletPromptType.Bridge));
    expect(mockPollActiveBridgePrompts).not.toHaveBeenCalled();
    expect(screen.queryByText('bridgePromptTitle')).not.toBeInTheDocument();
  });

  it('completes the bridge prompt once the poll settles the last bridge', async () => {
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
        tokenPrices={{}}
      />
    );

    await waitFor(() => expect(mockPollActiveBridgePrompts).toHaveBeenCalledWith([bridgeTransaction]));
    await waitFor(() => expect(completePrompt).toHaveBeenCalledWith(WalletPromptType.Bridge));
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
        tokenPrices={{}}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'hotKeyHardwareErrorPromptAction' }));
    await waitFor(() => {
      expect(screen.getByTestId('prompt-card')).toHaveAttribute('data-status', 'failure');
    });
    errorSpy.mockRestore();
  });
});
