import React from 'react';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import type { TokenBalanceData } from 'lib/miden/front';
import type { WalletAccount } from 'lib/shared/types';
import type { PendingNoteValue } from 'lib/wallet-prompts';
import { WalletPromptStatus, WalletPromptType } from 'lib/wallet-prompts';

import { HomePrompts } from './HomePrompts';

const mockFaucet = jest.fn();
const mockGetInFlightFaucetRequest = jest.fn();
const mockFetchActiveBridgePrompts = jest.fn();
const mockUseWalletPromptStorage = jest.fn();
const mockFetchHotKeyHardwareError = jest.fn();
const mockFetchFaucetFundingMarker = jest.fn();
const mockSetFaucetFundingMarker = jest.fn();

let mockBaseFee: number | null = 0;
jest.mock('app/hooks/useVerificationBaseFee', () => ({ __esModule: true, default: () => mockBaseFee }));
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
    getInFlightFaucetRequest: (address: string) => mockGetInFlightFaucetRequest(address),
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
    mockFetchHotKeyHardwareError.mockResolvedValue(null);
    mockFetchFaucetFundingMarker.mockResolvedValue(null);
    mockSetFaucetFundingMarker.mockResolvedValue(undefined);
    mockGetInFlightFaucetRequest.mockReturnValue(null);
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
    expect(promptState.setPromptStatus).toHaveBeenCalledWith(WalletPromptType.Faucet, WalletPromptStatus.Pending);
  });

  it('re-offers a dismissed faucet prompt once the account can no longer pay a fee', () => {
    // Dismiss means "not now", not "never again". An account that has run its
    // native balance to zero on a fee-charging chain is stuck, and the prompt is
    // the way out -- keeping it hidden strands the user with no affordance.
    mockBaseFee = 10000;
    mockUseWalletPromptStorage.mockReturnValue(
      makePromptState({
        storage: {
          version: 1,
          prompts: { [WalletPromptType.Faucet]: WalletPromptStatus.Dismissed },
          pendingNotesDismissedIds: []
        }
      })
    );
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
    expect(completePrompt).toHaveBeenCalledWith(WalletPromptType.Faucet);
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
    const completePrompt = jest.fn();
    mockUseWalletPromptStorage.mockReturnValue(makePromptState({ completePrompt }));

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
        fundingNotes={pendingNotes}
        tokenPrices={tokenPrices}
      />
    );
    await waitFor(() => expect(faucetCard).toHaveAttribute('data-hero', 'faucetPromptFunded'));
    expect(faucetCard).toHaveAttribute('data-status', 'success');
    // The prompt is completed AT ARRIVAL, while the beat is still on screen: the
    // marker is cleared in the same pass, so deferring completion to the beat's
    // in-memory timer lost it whenever the app closed on this screen.
    expect(completePrompt).toHaveBeenCalledWith(WalletPromptType.Faucet);
    // The pending-notes card must hold back while the success beat plays —
    // it sorts first in the carousel and would push the hero off-screen.
    expect(screen.queryByText('pendingNotesPromptTitle')).not.toBeInTheDocument();
    // Beat over (FAUCET_FUNDED_BEAT_MS) → the pending-notes card takes the stage.
    await waitFor(() => expect(screen.getByText('pendingNotesPromptTitle')).toBeInTheDocument(), { timeout: 3500 });
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
        fundingNotes={[]}
        tokenPrices={{}}
      />
    );
    const faucetCard = screen.getAllByTestId('prompt-card')[0]!;
    // Let this account's funding marker read settle: the card is not offered
    // as actionable until it has.
    await act(async () => {});
    fireEvent.click(within(faucetCard).getByRole('button', { name: 'faucetPromptTitle' }));
    await waitFor(() => expect(mockFaucet).toHaveBeenCalledWith('accountA'));
    expect(completePrompt).not.toHaveBeenCalled();

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
        ? Promise.resolve({ requestedAt: Date.now() - 5_000, baselineNoteIds: [] })
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
    const completePrompt = jest.fn();
    mockUseWalletPromptStorage.mockReturnValue(makePromptState({ completePrompt }));
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
    expect(completePrompt).not.toHaveBeenCalled();

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
      mockFetchFaucetFundingMarker.mockResolvedValueOnce({ requestedAt: base, baselineNoteIds: [] });
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
      mockFetchFaucetFundingMarker.mockResolvedValue({ requestedAt: Date.now() - 170_000, baselineNoteIds: [] });
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
    const completePrompt = jest.fn();
    mockUseWalletPromptStorage.mockReturnValue(makePromptState({ completePrompt }));

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

    await waitFor(() => expect(completePrompt).toHaveBeenCalledWith(WalletPromptType.Faucet), { timeout: 3500 });
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
    expect(mockSetFaucetFundingMarker).toHaveBeenCalledWith(
      'accountA',
      expect.objectContaining({ baselineNoteIds: pendingNotes.map(note => note.id) })
    );
  });

  it('does not start a mint while the funding marker for this account is still being read', async () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());
    // A mint that acked before a remount has no in-flight join left; only the
    // persisted marker says it is still inbound. Until that read settles, a tap
    // must not be able to start a second real mint.
    let settleRead!: (marker: { requestedAt: number; baselineNoteIds: string[] } | null) => void;
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
      settleRead({ requestedAt: Date.now() - 10_000, baselineNoteIds: [] });
    });
    await waitFor(() =>
      expect(screen.getAllByTestId('prompt-card')[0]!).toHaveAttribute('data-hero', 'faucetPromptFunding')
    );
    fireEvent.click(screen.getByRole('button', { name: 'faucetPromptTitle' }));
    expect(mockFaucet).not.toHaveBeenCalled();
  });

  it('treats a balance as arrival even while the claimable notes are still loading', async () => {
    const completePrompt = jest.fn();
    mockUseWalletPromptStorage.mockReturnValue(makePromptState({ completePrompt }));
    // Resume a wait whose notes never load: only the balance can signal arrival.
    mockFetchFaucetFundingMarker.mockResolvedValue({ requestedAt: Date.now() - 10_000, baselineNoteIds: [] });

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

  it('does not let a delayed marker write overwrite the wait another account started', async () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());
    // A's marker write hangs; B's resolves. fundingWait is a single slot.
    let persistA!: () => void;
    mockSetFaucetFundingMarker.mockImplementation((address: string) =>
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

    // A's write finally lands. Installing A's wait now would evict B's, dropping
    // B's arrival, success beat and backstop.
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
      mockFetchFaucetFundingMarker.mockResolvedValueOnce({ requestedAt: Date.now() - 170_000, baselineNoteIds: [] });
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
    const completePrompt = jest.fn();
    mockUseWalletPromptStorage.mockReturnValue(makePromptState({ completePrompt }));
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
    expect(completePrompt).toHaveBeenCalledWith(WalletPromptType.Faucet);
  });

  it('does not re-offer Fund after completion while the minted note is still claimable', async () => {
    // A fee-charging chain: main's fee-broke re-arm shows the card again after
    // completion, until the minted native note is consumed into the balance.
    mockBaseFee = 10000;
    mockUseWalletPromptStorage.mockReturnValue(
      makePromptState({
        storage: {
          version: 1,
          prompts: { [WalletPromptType.Faucet]: WalletPromptStatus.Completed },
          pendingNotesDismissedIds: []
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

  it('does not count a non-native note as the mint arriving', async () => {
    const completePrompt = jest.fn();
    mockUseWalletPromptStorage.mockReturnValue(makePromptState({ completePrompt }));

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
    // the success beat — the request only ever mints native MIDEN.
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
    expect(completePrompt).not.toHaveBeenCalled();

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
    await waitFor(() => expect(completePrompt).toHaveBeenCalledWith(WalletPromptType.Faucet), { timeout: 3500 });
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
    // The switch has to land BETWEEN the tap and the marker write resolving:
    // that is the only window in which a wait is installed for an account that
    // is no longer on screen, so the account-switch effect cannot drop it.
    let persistMarker!: () => void;
    mockSetFaucetFundingMarker.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          persistMarker = () => resolve();
        })
    );
    let rejectFaucet!: (error: Error) => void;
    mockFaucet.mockReturnValue(
      new Promise<void>((_resolve, reject) => {
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
    // Now the write lands and installs accountA's wait while accountB is shown.
    await act(async () => {
      persistMarker();
      await Promise.resolve();
    });
    await act(async () => {
      rejectFaucet(new Error('rate limited'));
      await Promise.resolve();
      await Promise.resolve();
    });

    // The failed request clears A's persisted marker even though B was on screen;
    // without this the mocked read below returns null regardless and proves nothing.
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
    const cardAfterSwitchBack = screen.getAllByTestId('prompt-card')[0]!;
    expect(cardAfterSwitchBack).not.toHaveAttribute('data-hero', 'faucetPromptFunding');
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

    await waitFor(() => expect(mockFaucet).toHaveBeenCalledWith('accountB'));
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
        fundingNotes={pendingNotes}
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
        fundingNotes={pendingNotes}
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
        fundingNotes={[pendingNotes[0]!, { ...pendingNotes[1]!, id: 'note-3' }]}
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
