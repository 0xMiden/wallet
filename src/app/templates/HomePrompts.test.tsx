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
    onClick,
    actionLabel,
    onAction,
    actionDisabled,
    status,
    onDismiss
  }: {
    title: string;
    body?: string;
    onClick?: () => void;
    actionLabel?: string;
    onAction?: () => void;
    actionDisabled?: boolean;
    status?: string;
    onDismiss?: () => void;
  }) => (
    <section data-testid="prompt-card" data-title={title} data-status={status}>
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
    fetchHotKeyHardwareError: () => mockFetchHotKeyHardwareError(),
    pollActiveBridgePrompts: (transactions: unknown[]) => mockPollActiveBridgePrompts(transactions),
    useWalletPromptStorage: () => mockUseWalletPromptStorage()
  };
});

jest.mock('lib/woozie', () => ({ navigate: jest.fn() }));

const mockInitiateReplaceHotKeyTransaction = jest.fn();
const mockRequestSWTransactionProcessing = jest.fn();
jest.mock('lib/miden/activity', () => ({
  initiateReplaceHotKeyTransaction: (...args: unknown[]) => mockInitiateReplaceHotKeyTransaction(...args),
  requestSWTransactionProcessing: () => mockRequestSWTransactionProcessing()
}));
jest.mock('lib/miden/front/guardian-sync', () => ({ zustandProvider: { tag: 'zustand-provider' } }));
jest.mock('lib/settings/helpers', () => ({ isDelegateProofEnabled: () => true }));
jest.mock('lib/platform', () => ({ isExtension: () => false }));
// FundWalletDrawer — passthrough stub exposing the funding lifecycle props so
// the wiring (open / state / errorMessage / onRetry / onDone / onOpenChange)
// can be asserted without dragging the real vaul drawer into the DOM.
jest.mock('app/templates/FundWalletDrawer', () => ({
  FundWalletDrawer: ({
    open,
    onOpenChange,
    state,
    errorMessage,
    onRetry,
    onDone
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    state: string;
    errorMessage?: string;
    onRetry: () => void;
    onDone: () => void;
  }) => (
    <div data-testid="fund-drawer" data-open={String(open)} data-state={state}>
      <span data-testid="fund-drawer-error">{errorMessage ?? ''}</span>
      <button data-testid="fund-drawer-retry" onClick={onRetry} />
      <button data-testid="fund-drawer-done" onClick={onDone} />
      <button data-testid="fund-drawer-close" onClick={() => onOpenChange(false)} />
    </div>
  )
}));

const account = {
  publicKey: 'accountA',
  name: 'Account A',
  isPublic: false,
  hdIndex: 0
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

  it('opens the funding drawer, funds, and completes from the faucet button', async () => {
    const completePrompt = jest.fn();
    mockUseWalletPromptStorage.mockReturnValue(makePromptState({ completePrompt }));

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
    fireEvent.click(within(faucetCard).getByRole('button', { name: 'faucetPromptAction' }));

    const drawer = screen.getByTestId('fund-drawer');
    await waitFor(() => expect(drawer).toHaveAttribute('data-open', 'true'));
    await waitFor(() => expect(mockFaucet).toHaveBeenCalledWith('accountA'));
    expect(mockFaucet).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(drawer).toHaveAttribute('data-state', 'success'));
    expect(completePrompt).toHaveBeenCalledWith(WalletPromptType.Faucet);

    // Done closes the drawer.
    fireEvent.click(screen.getByTestId('fund-drawer-done'));
    await waitFor(() => expect(drawer).toHaveAttribute('data-open', 'false'));
  });

  it('surfaces the real faucet error in the drawer and retries from it', async () => {
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
    fireEvent.click(within(faucetCard).getByRole('button', { name: 'faucetPromptAction' }));

    const drawer = screen.getByTestId('fund-drawer');
    await waitFor(() => expect(drawer).toHaveAttribute('data-state', 'error'));
    expect(screen.getByTestId('fund-drawer-error')).toHaveTextContent('rate limited');

    // Retry re-invokes the faucet and recovers to success.
    fireEvent.click(screen.getByTestId('fund-drawer-retry'));
    await waitFor(() => expect(mockFaucet).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(drawer).toHaveAttribute('data-state', 'success'));
  });

  it('stringifies a non-Error faucet rejection into the drawer message', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockFaucet.mockRejectedValueOnce('boom');
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
    fireEvent.click(within(faucetCard).getByRole('button', { name: 'faucetPromptAction' }));

    const drawer = screen.getByTestId('fund-drawer');
    await waitFor(() => expect(drawer).toHaveAttribute('data-state', 'error'));
    expect(screen.getByTestId('fund-drawer-error')).toHaveTextContent('boom');
  });

  it('keeps the last outcome on close but re-opens fresh (not stale)', async () => {
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
    const action = within(faucetCard).getByRole('button', { name: 'faucetPromptAction' });

    fireEvent.click(action);
    const drawer = screen.getByTestId('fund-drawer');
    await waitFor(() => expect(drawer).toHaveAttribute('data-state', 'error'));
    expect(screen.getByTestId('fund-drawer-error')).toHaveTextContent('rate limited');

    // Dismiss (swipe / backdrop / X) does NOT synchronously reset — the sheet keeps
    // its last outcome as it animates out (no spinner flash), and a close mid-request
    // leaves the indicator alone (no double-fund re-enable).
    fireEvent.click(screen.getByTestId('fund-drawer-close'));
    await waitFor(() => expect(drawer).toHaveAttribute('data-open', 'false'));

    // Re-opening goes through fundWallet, which clears the stale error and starts
    // fresh on loading→success — never the old error.
    fireEvent.click(action);
    await waitFor(() => expect(drawer).toHaveAttribute('data-state', 'success'));
    expect(screen.getByTestId('fund-drawer-error')).toHaveTextContent('');
  });

  it('keeps the fund action disabled after closing mid-request (no double-fund)', async () => {
    // The fundingRef re-entrancy guard was dropped; protection now rests on the
    // card's actionDisabled while the indicator is 'loading'. Closing the drawer
    // must NOT reset the indicator, or a still-in-flight request could be fired
    // again from the re-enabled card.
    let resolveFaucet: () => void = () => undefined;
    mockFaucet.mockReturnValueOnce(
      new Promise<void>(resolve => {
        resolveFaucet = () => resolve();
      })
    );
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
    const action = within(faucetCard).getByRole('button', { name: 'faucetPromptAction' });

    fireEvent.click(action);
    const drawer = screen.getByTestId('fund-drawer');
    await waitFor(() => expect(drawer).toHaveAttribute('data-state', 'loading'));
    expect(action).toBeDisabled();

    // Dismiss while the request is still in flight.
    fireEvent.click(screen.getByTestId('fund-drawer-close'));
    await waitFor(() => expect(drawer).toHaveAttribute('data-open', 'false'));

    // Indicator stays 'loading' → the card action remains disabled, faucet uncalled again.
    expect(action).toBeDisabled();
    expect(mockFaucet).toHaveBeenCalledTimes(1);

    // Let the in-flight request settle.
    await act(async () => {
      resolveFaucet();
    });
    expect(mockFaucet).toHaveBeenCalledTimes(1);
  });

  it('does not fund when the faucet card content is clicked', () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'faucetPromptTitle' }));

    expect(mockFaucet).not.toHaveBeenCalled();
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

  it('shows pending notes first with their USD value and action-only navigation', () => {
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

    fireEvent.click(screen.getByRole('button', { name: 'pendingNotesPromptTitle' }));
    expect(jest.requireMock('lib/woozie').navigate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'pendingNotesPromptAction' }));
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
